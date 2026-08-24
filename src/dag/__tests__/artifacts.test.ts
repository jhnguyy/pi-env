import { createHash } from "node:crypto";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { it as effectIt } from "@effect/vitest";
import {
  DagArtifactFailureTag,
  DagArtifactAmbiguousOutput,
  DagBlockedReason,
  DagArtifactIdentityMismatch,
  DagArtifactMalformedReference,
  DagArtifactMissingOutput,
  DagArtifactOutputLimitExceeded,
  DagArtifactPathRejected,
  DagArtifactUnsupportedMedia,
  DagDefaultArtifactLimits,
  DagDependencyMode,
  DagNodeResultTag,
  DagNodeStatus,
  admitDagTextArtifacts,
  createDagRunState,
  DagRunOutcome,
  DagTransitionResultTag,
  DagTransitionType,
  makeDagSessionWriter,
  materializeDagTextContext,
  parseDagTextArtifactReference,
  reconstructDagSession,
  reduceDagRunState,
  selectDagTextArtifactReferences,
  type DagSessionStore,
  type DagTextArtifactReference,
} from "../index.js";
import * as Shared from "./shared.js";

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "pi-dag-artifacts-"));
}

describe("DAG text artifact contract", () => {
  effectIt.effect("admits contained text artifacts and materializes full UTF-8 from an explicit root", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => tempRoot());
      yield* Effect.promise(() => mkdir(path.join(root, "out")));
      yield* Effect.promise(() => writeFile(path.join(root, "out", "hello.txt"), "hello π"));
      yield* Effect.promise(() => writeFile(path.join(root, "..inside.txt"), "inside"));
      const unusualNames = yield* admitDagTextArtifacts(
        root,
        "run-test",
        "producer",
        Object.fromEntries([["__proto__", "out/hello.txt"], ["dot-prefix", "..inside.txt"]]),
      );
      expect(Object.hasOwn(unusualNames, "__proto__")).toBe(true);
      expect(unusualNames["__proto__"].outputName).toBe("__proto__");
      expect(unusualNames["dot-prefix"].path).toBe("..inside.txt");
      const malformedIdentity = yield* admitDagTextArtifacts(root, "", "producer", { answer: "out/hello.txt" }).pipe(Effect.flip);
      expect(malformedIdentity._tag).toBe(DagArtifactFailureTag.MalformedReference);
      const outputs = yield* admitDagTextArtifacts(root, "run-test", "producer", { answer: "out/hello.txt" });
      expect(Object.isFrozen(outputs)).toBe(true);
      expect(outputs.answer).toMatchObject({
        v: 1,
        path: path.join("out", "hello.txt"),
        bytes: Buffer.byteLength("hello π"),
        mediaType: "text/plain",
        encoding: "utf-8",
        runId: "run-test",
        producerNodeId: "producer",
        outputName: "answer",
      });
      expect(outputs.answer.digest).toMatch(/^[0-9a-f]{64}$/u);

      const producer = Shared.node("producer");
      const target = Shared.node("target", [{ nodeId: "producer", mode: DagDependencyMode.Required }]);
      const dag = Shared.graph([producer, target]);
      const state = Shared.finish(dag, createDagRunState(dag), "producer", { _tag: DagNodeResultTag.Succeeded, outputs });
      const otherRoot = yield* Effect.promise(() => tempRoot());
      yield* Effect.promise(() => mkdir(path.join(otherRoot, "out")));
      yield* Effect.promise(() => writeFile(path.join(otherRoot, "out", "hello.txt"), "wrong root"));

      const context = yield* materializeDagTextContext(root, "run-test", target, state, ["answer"]);
      expect(context.bytes).toBe(Buffer.byteLength("hello π"));
      expect(context.outputs.map((output) => output.text)).toEqual(["hello π"]);
      expect(Object.isFrozen(context)).toBe(true);
      expect(Object.isFrozen(context.outputs)).toBe(true);
      expect(Object.isFrozen(context.outputs[0])).toBe(true);
      expect(Object.isFrozen(context.outputs[0].reference)).toBe(true);
    }));

  it("parses only exact immutable v1 references", () => {
    const reference = parseDagTextArtifactReference({
      v: 1,
      path: "a.txt",
      bytes: 1,
      digestAlgorithm: "sha256",
      digest: "a".repeat(64),
      mediaType: "text/plain",
      encoding: "utf-8",
      runId: "run",
      producerNodeId: "node",
      outputName: "out",
    });
    expect(Object.isFrozen(reference)).toBe(true);
    for (const bad of [
      { ...reference, v: 2 },
      { ...reference, digestAlgorithm: "sha512" },
      { ...reference, digest: "A".repeat(64) },
      { ...reference, extra: true },
      { ...reference, bytes: -1 },
      { ...reference, runId: "" },
      { ...reference, producerNodeId: "" },
      { ...reference, outputName: "" },
    ]) expect(() => parseDagTextArtifactReference(bad)).toThrow(DagArtifactMalformedReference);
    expect(() => parseDagTextArtifactReference({ ...reference, path: "../outside.txt" })).toThrow(DagArtifactPathRejected);
    expect(() => parseDagTextArtifactReference({ ...reference, path: "/outside.txt" })).toThrow(DagArtifactPathRejected);
    expect(() => parseDagTextArtifactReference({ ...reference, mediaType: "application/json" })).toThrow(DagArtifactUnsupportedMedia);
    expect(() => parseDagTextArtifactReference({ ...reference, encoding: "utf-16" })).toThrow(DagArtifactUnsupportedMedia);
  });

  it("keeps session references shaped as metadata only", () => {
    const reference = parseDagTextArtifactReference({
      v: 1,
      path: "a.txt",
      bytes: 1,
      digestAlgorithm: "sha256",
      digest: "a".repeat(64),
      mediaType: "text/plain",
      encoding: "utf-8",
      runId: "run",
      producerNodeId: "node",
      outputName: "out",
    });
    expect(Object.keys(reference).sort()).toEqual(["bytes", "digest", "digestAlgorithm", "encoding", "mediaType", "outputName", "path", "producerNodeId", "runId", "v"]);
    expect(JSON.stringify(reference)).not.toContain("artifact text");
  });

  effectIt.effect("rejects lexical, canonical, and symlink escapes while accepting contained symlinks", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => tempRoot());
      const outside = yield* Effect.promise(() => tempRoot());
      yield* Effect.promise(() => writeFile(path.join(root, "inside.txt"), "ok"));
      yield* Effect.promise(() => writeFile(path.join(outside, "outside.txt"), "no"));
      yield* Effect.promise(() => symlink(path.join(root, "inside.txt"), path.join(root, "inside-link.txt")));
      yield* Effect.promise(() => symlink(path.join(outside, "outside.txt"), path.join(root, "outside-link.txt")));

      const accepted = yield* admitDagTextArtifacts(root, "run", "node", { x: "inside-link.txt" });
      expect(accepted.x.bytes).toBe(2);
      for (const badPath of ["", ".", "/tmp/nope", "C:\\nope", "\\\\server\\share", "bad\0path", "../escape", `..${path.sep}${path.basename(root)}-prefix`]) {
        const exit = yield* admitDagTextArtifacts(root, "run", "node", { x: badPath }).pipe(Effect.exit);
        expect(String(exit)).toContain(DagArtifactFailureTag.PathRejected);
      }
      const exit = yield* admitDagTextArtifacts(root, "run", "node", { x: "outside-link.txt" }).pipe(Effect.exit);
      expect(String(exit)).toContain(DagArtifactFailureTag.Containment);
    }));

  effectIt.effect("rejects missing, non-file, replaced, size, digest, UTF-8, and unsupported references", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => tempRoot());
      yield* Effect.promise(() => mkdir(path.join(root, "dir")));
      yield* Effect.promise(() => writeFile(path.join(root, "file.txt"), "abc"));
      const admitted = yield* admitDagTextArtifacts(root, "run", "node", { out: "file.txt" });
      const ref = admitted.out;

      const variants: Array<[DagTextArtifactReference, string]> = [
        [{ ...ref, path: "missing.txt" }, DagArtifactFailureTag.MissingFile],
        [{ ...ref, path: "dir" }, DagArtifactFailureTag.NotFile],
        [{ ...ref, bytes: 4 }, DagArtifactFailureTag.SizeMismatch],
        [{ ...ref, digest: "0".repeat(64) }, DagArtifactFailureTag.DigestMismatch],
        [{ ...ref, mediaType: "application/json" as "text/plain" }, DagArtifactFailureTag.UnsupportedMedia],
        [{ ...ref, encoding: "utf-16" as "utf-8" }, DagArtifactFailureTag.UnsupportedMedia],
      ];
      for (const [raw, tag] of variants) {
        const failure = yield* materializeOne(root, raw).pipe(Effect.flip);
        expect(failure._tag).toBe(tag);
        if (failure._tag === DagArtifactFailureTag.MissingFile) expect(failure.cause).toBeDefined();
      }

      yield* Effect.promise(() => writeFile(path.join(root, "file.txt"), "abcd"));
      const changed = yield* materializeOne(root, ref).pipe(Effect.flip);
      expect(changed._tag).toBe(DagArtifactFailureTag.SizeMismatch);

      yield* Effect.promise(() => writeFile(path.join(root, "bad.bin"), Buffer.from([0xff])));
      const utf8 = yield* admitDagTextArtifacts(root, "run", "node", { bad: "bad.bin" }).pipe(Effect.flip);
      expect(utf8._tag).toBe(DagArtifactFailureTag.Utf8);
    }));

  it("selects deterministic succeeded direct dependencies only and reports missing/ambiguous/identity failures", () => {
    const a = Shared.node("a");
    const b = Shared.node("b");
    const c = Shared.node("c");
    const target = Shared.node("target", ["b", "a", "c"].map((nodeId) => ({ nodeId, mode: DagDependencyMode.Settled })));
    const dag = Shared.graph([a, b, c, target]);
    const base = createDagRunState(dag);
    const ref = (producerNodeId: string, outputName: string): DagTextArtifactReference => Object.freeze({
      v: 1,
      path: `${producerNodeId}-${outputName}.txt`,
      bytes: 1,
      digestAlgorithm: "sha256",
      digest: "a".repeat(64),
      mediaType: "text/plain",
      encoding: "utf-8",
      runId: "run-test",
      producerNodeId,
      outputName,
    });
    const state = [
      ["b", { beta: ref("b", "beta") }],
      ["a", { alpha: ref("a", "alpha") }],
      ["c", { gamma: ref("c", "gamma") }],
    ].reduce((s, [id, outputs]) => Shared.finish(dag, s, id as string, { _tag: DagNodeResultTag.Succeeded, outputs: outputs as Record<string, DagTextArtifactReference> }), base);
    const selected = selectDagTextArtifactReferences("run-test", target, state, ["gamma", "alpha"]);
    expect(selected.map((item) => item.outputName)).toEqual(["alpha", "gamma"]);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected[0])).toBe(true);

    const codeUnitProducers = [Shared.node("z"), Shared.node("ä")];
    const codeUnitTarget = Shared.node("code-unit-target", codeUnitProducers.map((node) => ({
      nodeId: node.id,
      mode: DagDependencyMode.Required,
    })));
    const codeUnitDag = Shared.graph([...codeUnitProducers, codeUnitTarget]);
    const codeUnitState = Shared.finish(
      codeUnitDag,
      Shared.finish(codeUnitDag, createDagRunState(codeUnitDag), "ä", {
        _tag: DagNodeResultTag.Succeeded,
        outputs: { unicode: ref("ä", "unicode") },
      }),
      "z",
      { _tag: DagNodeResultTag.Succeeded, outputs: { ascii: ref("z", "ascii") } },
    );
    expect(selectDagTextArtifactReferences("run-test", codeUnitTarget, codeUnitState, ["unicode", "ascii"])
      .map((item) => item.outputName)).toEqual(["ascii", "unicode"]);

    expect(() => selectDagTextArtifactReferences("run-test", target, state, ["missing"])).toThrow(DagArtifactMissingOutput);
    expect(() => selectDagTextArtifactReferences("run-test", target, state, ["alpha", "alpha"])).toThrow(DagArtifactAmbiguousOutput);

    const ambiguous = Shared.finish(dag, Shared.finish(dag, base, "a", { _tag: DagNodeResultTag.Succeeded, outputs: { same: ref("a", "same") } }), "b", { _tag: DagNodeResultTag.Succeeded, outputs: { same: ref("b", "same") } });
    expect(() => selectDagTextArtifactReferences("run-test", target, ambiguous, ["same"])).toThrow(DagArtifactAmbiguousOutput);
    const wrongIdentity = Shared.finish(dag, base, "a", { _tag: DagNodeResultTag.Succeeded, outputs: { alpha: ref("b", "alpha") } });
    expect(() => selectDagTextArtifactReferences("run-test", target, wrongIdentity, ["alpha"])).toThrow(DagArtifactIdentityMismatch);
    const malformedUnrequested = Shared.finish(dag, base, "a", {
      _tag: DagNodeResultTag.Succeeded,
      outputs: { alpha: ref("a", "alpha"), ignored: { invalid: true } },
    });
    expect(selectDagTextArtifactReferences("run-test", target, malformedUnrequested, ["alpha"])).toHaveLength(1);

    for (const status of [DagNodeStatus.Failed, DagNodeStatus.Cancelled, DagNodeStatus.Interrupted, DagNodeStatus.Blocked, DagNodeStatus.Queued] as const) {
      const nodeState =
        status === DagNodeStatus.Failed
          ? { nodeId: "a", status, failure: "no", outputs: { alpha: ref("a", "alpha") } }
          : status === DagNodeStatus.Blocked
            ? { nodeId: "a", status, reason: DagBlockedReason.RequiredDependency, blockedBy: ["x"], outputs: { alpha: ref("a", "alpha") } }
            : { nodeId: "a", status, reason: "no", outputs: { alpha: ref("a", "alpha") } };
      expect(() => selectDagTextArtifactReferences("run-test", target, { ...base, nodes: [nodeState, ...base.nodes.slice(1)] } as never, ["alpha"])).toThrow(DagArtifactMissingOutput);
    }

    const tooMany = Object.fromEntries(Array.from({ length: DagDefaultArtifactLimits.maxOutputsPerNode + 1 }, (_, index) => [`o${index}`, ref("a", `o${index}`)]));
    const replayedOverflow = Shared.finish(dag, base, "a", { _tag: DagNodeResultTag.Succeeded, outputs: tooMany });
    expect(() => selectDagTextArtifactReferences("run-test", target, replayedOverflow, ["o0"])).toThrow(DagArtifactOutputLimitExceeded);
  });

  effectIt.effect("session round-trip stores references without artifact bytes and replay does not read files", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => tempRoot());
      yield* Effect.promise(() => writeFile(path.join(root, "artifact.txt"), "secret bytes"));
      const outputs = yield* admitDagTextArtifacts(root, "run-test", "producer", { out: "artifact.txt" });
      const producer = { ...Shared.node("producer"), executor: { ...Shared.executor, payload: null } };
      const dagDefinition = { runId: "run-test", concurrency: 1, nodes: [producer] };
      const dag = Shared.graph([producer], 1);
      const entries: unknown[] = [];
      const store: DagSessionStore = {
        read: () => entries,
        append: (entry) => {
          entries.push(entry);
        },
      };
      const writer = makeDagSessionWriter(store, dag, dagDefinition);
      yield* writer.appendGraph(dagDefinition);
      const start = { runId: "run-test", nodeId: "producer", type: DagTransitionType.Start } as const;
      yield* writer.appendTransition(start, { nodeId: "producer", attemptId: "run-test:producer:1", ordinal: 1, status: DagNodeStatus.Running });
      const stateAfterStart = reduceDagRunState(dag, createDagRunState(dag), start);
      expect(stateAfterStart._tag).toBe(DagTransitionResultTag.Applied);
      const complete = { runId: "run-test", nodeId: "producer", type: DagTransitionType.Complete, result: { _tag: DagNodeResultTag.Succeeded, outputs } } as const;
      yield* writer.appendTransition(complete, { nodeId: "producer", attemptId: "run-test:producer:1", ordinal: 1, status: DagNodeStatus.Succeeded });
      yield* writer.appendFinal(DagRunOutcome.Succeeded);
      expect(JSON.stringify(entries)).toContain('"path":"artifact.txt"');
      expect(JSON.stringify(entries)).not.toContain("secret bytes");
      expect(JSON.stringify(entries)).not.toContain('"text":');
      yield* Effect.promise(() => writeFile(path.join(root, "artifact.txt"), "changed after persist"));
      const replayed = yield* reconstructDagSession(store, "run-test");
      const replayedProducer = replayed.state.nodes.find((node) => node.nodeId === "producer");
      expect(replayedProducer?.status).toBe(DagNodeStatus.Succeeded);
    }));

  effectIt.effect("enforces exact count and byte boundaries without partial text", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => tempRoot());
      const exact = "x".repeat(DagDefaultArtifactLimits.maxArtifactBytes);
      yield* Effect.promise(() => writeFile(path.join(root, "exact.txt"), exact));
      const admitted = yield* admitDagTextArtifacts(root, "run", "node", { exact: "exact.txt" });
      expect(admitted.exact.bytes).toBe(DagDefaultArtifactLimits.maxArtifactBytes);
      yield* Effect.promise(() => writeFile(path.join(root, "too-big.txt"), `${exact}x`));
      const tooBig = yield* admitDagTextArtifacts(root, "run", "node", { bad: "too-big.txt" }).pipe(Effect.flip);
      expect(tooBig._tag).toBe(DagArtifactFailureTag.ArtifactLimitExceeded);

      yield* Effect.promise(() => writeFile(path.join(root, "tiny.txt"), "x"));
      const exactCount = Object.fromEntries(Array.from({ length: DagDefaultArtifactLimits.maxOutputsPerNode }, (_, index) => [`o${index}`, "tiny.txt"]));
      const exactCountAdmitted = yield* admitDagTextArtifacts(root, "run", "node", exactCount);
      expect(Object.keys(exactCountAdmitted)).toHaveLength(DagDefaultArtifactLimits.maxOutputsPerNode);
      const many = { ...exactCount, overflow: "exact.txt" };
      const count = yield* admitDagTextArtifacts(root, "run", "node", many).pipe(Effect.flip);
      expect(count._tag).toBe(DagArtifactFailureTag.OutputLimitExceeded);

      for (let index = 0; index < 8; index += 1) yield* Effect.promise(() => writeFile(path.join(root, `max-${index}.txt`), exact));
      const exactNodeOutputs = Object.fromEntries(Array.from({ length: 4 }, (_, index) => [`n${index}`, `max-${index}.txt`]));
      const exactNode = yield* admitDagTextArtifacts(root, "run", "node", exactNodeOutputs);
      expect(Object.values(exactNode).reduce((sum, reference) => sum + reference.bytes, 0)).toBe(DagDefaultArtifactLimits.maxBytesPerNode);
      const contextReferences = Array.from({ length: 8 }, (_, index) => ({ ...admitted.exact, path: `max-${index}.txt`, producerNodeId: `p${index}`, outputName: `c${index}` }));
      const exactContext = yield* materializeReferences(root, contextReferences.map((reference) => reference.producerNodeId), contextReferences);
      expect(exactContext.bytes).toBe(DagDefaultArtifactLimits.maxContextBytes);

      const understated = { ...admitted.exact, bytes: 2, digest: createHash("sha256").update("xx").digest("hex") };
      const exit = yield* materializeOne(root, understated).pipe(Effect.flip);
      expect(exit._tag).toBe(DagArtifactFailureTag.SizeMismatch);

      const nodeRefs = Array.from({ length: 5 }, (_, index) => makeReference("run", "node", `o${index}`, `f${index}.txt`, DagDefaultArtifactLimits.maxArtifactBytes));
      const nodeOverflow = yield* materializeReferences(root, ["node"], nodeRefs).pipe(Effect.flip);
      expect(nodeOverflow._tag).toBe(DagArtifactFailureTag.NodeLimitExceeded);
      if (nodeOverflow._tag === DagArtifactFailureTag.NodeLimitExceeded) expect(nodeOverflow.max).toBe(DagDefaultArtifactLimits.maxBytesPerNode);

      const contextRefs = Array.from({ length: 9 }, (_, index) => makeReference("run", `p${index}`, `out${index}`, `c${index}.txt`, DagDefaultArtifactLimits.maxArtifactBytes));
      const contextOverflow = yield* materializeReferences(root, contextRefs.map((ref) => ref.producerNodeId), contextRefs).pipe(Effect.flip);
      expect(contextOverflow._tag).toBe(DagArtifactFailureTag.ContextLimitExceeded);
      if (contextOverflow._tag === DagArtifactFailureTag.ContextLimitExceeded) expect(contextOverflow.max).toBe(DagDefaultArtifactLimits.maxContextBytes);
    }));
});

function makeReference(runId: string, producerNodeId: string, outputName: string, filePath: string, bytes: number): DagTextArtifactReference {
  return Object.freeze({
    v: 1,
    path: filePath,
    bytes,
    digestAlgorithm: "sha256",
    digest: "a".repeat(64),
    mediaType: "text/plain",
    encoding: "utf-8",
    runId,
    producerNodeId,
    outputName,
  });
}

function materializeOne(root: string, reference: DagTextArtifactReference) {
  return materializeReferences(root, [reference.producerNodeId], [reference]);
}

function materializeReferences(root: string, producerNodeIds: readonly string[], references: readonly DagTextArtifactReference[]) {
  const producers = producerNodeIds.map((nodeId) => Shared.node(nodeId));
  const target = Shared.node("target", producerNodeIds.map((nodeId) => ({ nodeId, mode: DagDependencyMode.Required })));
  const dag = Shared.graph([...producers, target]);
  const state = producers.reduce((current, producer) => {
    const outputs = Object.fromEntries(references.filter((reference) => reference.producerNodeId === producer.id).map((reference) => [reference.outputName, reference]));
    return Shared.finish(dag, current, producer.id, { _tag: DagNodeResultTag.Succeeded, outputs });
  }, createDagRunState(dag));
  return materializeDagTextContext(root, references[0]?.runId ?? "run", target, state, references.map((reference) => reference.outputName));
}
