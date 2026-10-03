import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { expect } from "vite-plus/test";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";

function shellStep(workflow: string, marker: string) {
  const start = workflow.indexOf(marker);
  if (start < 0) throw new Error(`Missing workflow step: ${marker}`);
  const lines = workflow.slice(start).split("\n");
  const run = lines.indexOf("        run: |");
  if (run < 0) throw new Error(`Missing shell script: ${marker}`);
  const script: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.length > 0 && !line.startsWith("          ")) break;
    script.push(line.slice(10));
  }
  return script.join("\n");
}

const encodeDesktopPackage = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
);

const fixture = Effect.fn("forkReleaseFixture")(function* (base = "0.0.40", tags: string[] = []) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const workflow = yield* fs.readFileString(
    yield* path.fromFileUrl(new URL("../.github/workflows/release-fork.yml", import.meta.url)),
  );
  const versionScript = shellStep(workflow, "      - id: meta\n");
  const publishScript = shellStep(workflow, "      - name: Create release\n");
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-release-" });
  const env = {
    PATH: (yield* HostProcessEnvironment).PATH ?? "",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Release test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Release test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    RAW_VERSION: "",
    GITHUB_OUTPUT: path.join(cwd, "output"),
    GITHUB_STEP_SUMMARY: path.join(cwd, "summary"),
  };
  const command = Effect.fn("forkReleaseCommand")(function* (
    executable: string,
    args: string[],
    overrides: Record<string, string> = {},
  ) {
    const handle = yield* spawner.spawn(
      ChildProcess.make(executable, args, {
        cwd,
        env: { ...env, ...overrides },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    return yield* Effect.all(
      {
        status: handle.exitCode,
        stdout: handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
        stderr: handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
      },
      { concurrency: "unbounded" },
    );
  });
  const git = Effect.fn("forkReleaseGit")(function* (...args: string[]) {
    const result = yield* command("git", args);
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  });
  yield* fs.makeDirectory(path.join(cwd, "apps/desktop"), { recursive: true });
  yield* fs.writeFileString(
    path.join(cwd, "apps/desktop/package.json"),
    encodeDesktopPackage({ version: base }),
  );
  yield* git("init", "--initial-branch=devin");
  yield* git("add", ".");
  yield* git("commit", "-m", "fixture");
  yield* git("update-ref", "refs/remotes/origin/devin", "HEAD");
  for (const tag of tags) yield* git("tag", tag);
  const run = Effect.fn("forkReleaseVersionStep")(function* (
    overrides: Record<string, string> = {},
  ) {
    const result = yield* command("bash", ["-c", versionScript], overrides);
    const output = (yield* fs.exists(env.GITHUB_OUTPUT))
      ? yield* fs.readFileString(env.GITHUB_OUTPUT)
      : "";
    return {
      ...result,
      output: Object.fromEntries(
        output
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => line.split("=")),
      ),
    };
  });
  return { cwd, fs, path, git, run, command, publishScript };
});

it.layer(NodeServices.layer)("fork release workflow", (it) => {
  for (const { base, tags, expected } of [
    { base: "0.0.40", tags: [], expected: "0.0.40-fork.1" },
    { base: "0.0.40", tags: ["v0.0.40-fork.1", "v0.0.40-fork.2"], expected: "0.0.40-fork.3" },
    { base: "0.0.40", tags: ["v0.0.40-fork.2", "v0.0.40-fork.10"], expected: "0.0.40-fork.11" },
    { base: "0.0.41", tags: ["v0.0.40-fork.99"], expected: "0.0.41-fork.1" },
    {
      base: "0.0.40",
      tags: ["v0.0.40-fork.3", "v0.0.40-fork.99-extra", "v0.0.40-fork.abc"],
      expected: "0.0.40-fork.4",
    },
  ]) {
    it.effect(`allocates ${expected} from existing tags`, () =>
      Effect.gen(function* () {
        const test = yield* fixture(base, tags);
        const result = yield* test.run();
        expect(result.status, result.stderr).toBe(0);
        expect(result.output).toEqual({
          version: expected,
          tag: `v${expected}`,
          sha: yield* test.git("rev-parse", "HEAD"),
          should_build: "true",
        });
        expect(yield* test.git("diff", "--name-only")).toBe("");
      }),
    );
  }

  it.effect("accepts a higher explicitly requested revision", () =>
    Effect.gen(function* () {
      const test = yield* fixture("0.0.40", ["v0.0.40-fork.2"]);
      const result = yield* test.run({ RAW_VERSION: "v0.0.40-fork.7" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.output.version).toBe("0.0.40-fork.7");
    }),
  );

  for (const RAW_VERSION of [
    "0.0.40-fork.2",
    "0.0.40-fork.1",
    "0.0.41-fork.3",
    "0.0.40",
    "0.0.40-fork.03",
    "0.0.40-fork.0",
    "0.0.40-fork.3;exit 0",
  ]) {
    it.effect(`rejects invalid or non-increasing override ${RAW_VERSION}`, () =>
      Effect.gen(function* () {
        const test = yield* fixture("0.0.40", ["v0.0.40-fork.2"]);
        const result = yield* test.run({ RAW_VERSION });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("Version must be");
        expect(result.output.should_build).toBeUndefined();
      }),
    );
  }

  it.effect("rejects an invalid desktop base version", () =>
    Effect.gen(function* () {
      const test = yield* fixture("0.0.40-nightly.1");
      const result = yield* test.run();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Invalid desktop base version");
    }),
  );

  it.effect("skips a triggering commit removed by an upstream rebase", () =>
    Effect.gen(function* () {
      const test = yield* fixture();
      const replacement = yield* test.git("commit-tree", "HEAD^{tree}", "-m", "rebased fixture");
      yield* test.git("update-ref", "refs/remotes/origin/devin", replacement);
      const result = yield* test.run();
      expect(result.status, result.stderr).toBe(0);
      expect(result.output).toEqual({ should_build: "false" });
    }),
  );

  for (const matches of [true, false]) {
    it.effect(`marks only the current branch tip Latest: matches=${matches}`, () =>
      Effect.gen(function* () {
        const test = yield* fixture();
        const sha = yield* test.git("rev-parse", "HEAD");
        const capture = test.path.join(test.cwd, "publish-args");
        const result = yield* test.command(
          "bash",
          [
            "-c",
            `
        gh() {
          if [[ "$1" == "api" ]]; then printf '%s\\n' "$TEST_TIP";
          else printf '%s\\n' "$@" > "$TEST_CAPTURE"; fi
        }
        ${test.publishScript}
      `,
          ],
          {
            TEST_TIP: matches ? sha : "different-tip",
            TEST_CAPTURE: capture,
            GITHUB_REPOSITORY: "owner/repo",
            GITHUB_SHA: "pre-sync-event-sha",
            RELEASE_SHA: sha,
            TAG: "v0.0.40-fork.3",
            VERSION: "0.0.40-fork.3",
          },
        );
        expect(result.status, result.stderr).toBe(0);
        const args = (yield* test.fs.readFileString(capture)).split("\n");
        expect(args[args.indexOf("--target") + 1]).toBe(sha);
        expect(args).toContain(`--latest=${matches}`);
        expect(args).not.toContain("--prerelease");
      }),
    );
  }
});
