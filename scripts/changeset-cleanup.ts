import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Console, Effect, FileSystem, Layer, Path, pipe, Schema } from "effect"

// const PackageJson = Schema.Struct({
//   version: Schema.String,
//   name: Schema.String
// })
const Version = Schema.String
const PreJson = Schema.Struct({
  mode: Schema.String,
  tag: Schema.String,
  initialVersions: Schema.Record(Schema.String, Version),
  changesets: Schema.Array(Schema.String)
})

const getJson = Effect.fn(function*<S extends Schema.Schema<any>>(filePath: string, schema: S) {
  const fs = yield* FileSystem.FileSystem
  return yield* pipe(
    fs.readFile(filePath),
    Effect.map((buf) => buf.toString()),
    Effect.andThen((contents) =>
      Effect.try({
        try: () => JSON.parse(contents),
        catch: (error) =>
          Effect.fail(new Error(`Failed to parse ${filePath}: \n content: ${contents}`, { cause: error }))
      })
    ),
    Effect.andThen(Schema.decodeUnknownEffect(schema))
  )
})
const changesetsDir = ".changeset"
const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const preJson = yield* pipe(
    getJson(`${changesetsDir}/pre.json`, PreJson),
    Effect.catchReason(
      "PlatformError",
      "NotFound",
      () => Console.log(`No \`pre.json\` found in \`${changesetsDir}\` dir, skipping changeset cleanup.`)
    )
  )
  if (!preJson) return
  yield* Console.log("Starting changeset cleanup...")
  // const packageJson = yield* getJson("package.json", PackageJson)
  const changesetFiles = preJson?.changesets?.map((id) => `${id}.md`) ?? []
  if (changesetFiles.length === 0) {
    yield* Console.log("No changeset files to clean up.")
  } else {
    yield* Console.log(`Cleaning up changeset files`, changesetFiles)
  }
  yield* Effect.all(
    [
      ...(changesetFiles.map((file) => fs.remove(path.join(changesetsDir, file)))),
      fs.remove(`${changesetsDir}/pre.json`)
    ],
    { concurrency: "unbounded" }
  )
  yield* Console.log("Changeset cleanup completed.")
}).pipe(
  Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))
)

await Effect.runPromise(program)
