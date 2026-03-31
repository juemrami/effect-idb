
# mantra: keep simple things simple, make complex things possible
 - make the pit of success the obvious path

# a fundamental IDB constraint that no Effect abstraction can fully hide...
 - IDB transactions auto-commits at the turn of the event loop when there with no requests pending on the transaction.
	- "pending requests" here means event handler callbacks that have been dispatched but not yet returned
 - A any real async work in the middle of a transaction is a guaranteed to commit & close the transaction!

more succinctly/correctly put by a clanker:
	- Effect's default scheduler dispatches fiber steps via setTimeout in browsers (macrotask).
	- IDB transactions die at macrotask boundaries.
	- This means:
		- `Effect.fork` inside a transaction scope will kill it.
		- `Effect.sleep` will kill it.
		- Any real async work will kill it.
	- Single-fiber sequential IDB work within a transaction layer is safe as long as it doesn't cross a macrotask boundary.


- The question is then:
 - Does the transaction abstraction become narrow in its job by default;
	- ie it errors on object requests after async boundaries like normal idb transaction
 or
 - Does it attempt to handle async work by recognizing closed transactions and managing provisioning new ones as needed?
	- doing this would imply all that a transaction scoped to 4 object stores would always include all 4 when re-requested across async boundaries.


The latter option is more ergonomic and friendly to users that dont know the limitations of indexedb

```ts
yield* objectStoreA.write(data) // object store accessed, transaction is provisioned
yield* fetch("https://...") // / transaction is closed at async boundary, transaction registry still alive
yield* objectStoreB.write(data) // new transaction is provisioned when an object store is accessed after async
```

the former behaves in regards to the spec so it doesn't add additional mental models.
```ts
yield* objectStoreA.write(data)
yield* fetch("https://...") // finishes in a different marcotask/event-loop
yield* objectStoreB.write(data) // 💀 results in error because transaction is closed by then
```
instead, youd have data fetch outside of the transaction programs
```ts
// fetch first, outside the transaction
const data = yield* fetch("https://...")
// then open the transaction only for the IDB work
yield* Effect.gen(function*() {
  yield* objectStoreA.write(data)
  yield* objectStoreB.write(data)
}).pipe(Effect.provide(IDBTransaction.ReadWrite))
```

I can see the value of both, the former forces you to be a bite more strict.
More importantly, it doesn't hide any control flow, which makes it easier to debug from a consumers prespective.



## then comes figuring out what a transaction layer should conceptually be

This is tied to the previous question, but also to Effect and its runtime services caching strategy.

Effect layers are a way to define programs that build into services with some ergonomic helpers on top to help composability

During the layer build process for a fiber, a caching system called MemoMap is used to ensure sharing of built layers by default. primitives are offered to bypass this and even manually operate on the cache for advanced use cases.

When an effect runtime starts and encountered programs with their own provided layers(`Effect.provide`), the services layer is built with (with the current fibers last snapshot of the memomap) and results are added the fibers services cache

So if a `IDBTransaction.ReadWrite` layer is built for a fiber and an effect in the pipe needs to use that service as well because of a manual `Effect.provide` it will hit the memomap and return the same transaction. By default
- This fits nice with the first scenario of the transaction layer automatically provisioning new transactions across async boundaries, as the same transaction would be shared across child fibers by default, and the layer would handle provisioning new ones as needed when the transaction is closed.

So should the abstraction be a service around a mechanism for acquiring transaction handles as they are needed throughout a program.

Or should the abstraction be a service around a real transaction handle that is only guaranteed to exist for the synchronous portion of a program?

Perhaps both can be supported? but which to default?

## expectations around transaction abstraction layer caching

Regardless of the abstraction choice above, there is also still the question of how well does this fit into the mental model of effect's layer caching by default.

Because lets assume that a Layer construction of `IDBTransaction.ReadWrite` results in either a registry system or a simple raw handle wrapper: is the assumption that consequent provisions of `IDBTransaction.ReadWrite` nested in different subprograms of the same resulting program will share the same underlying abstraction object?

To seasoned effect users, they may expect this, they may know that a layer type is just a recipe, and when an effect is ran any effect that need that service point to its recipe, and the only way to give an effect its own recipe for service is to `Layer.fresh` the services layer.

Newer effect users may just try to mangle the layers together until the types work out.
one common strategy is to not provide layers to programs locally and to wait until you build your final program to see your final requirements channel and then start providing whats required to make your program not type error.
Imagine this case but where you have an object store service that does some readwrite work at some point in your program, and then the program does some other work for a while, and then it comes back to do more object store work.

Your final programs requirement channel doesnt have the context of the order in which the requirements are used -- nor the async boundaries in between.
So if its the case that 1 Transaction.ReadWriteLayer = 1 IndexedDB transaction handle, then the user may be surprised that their program is erroring because they are trying to use the same transaction across async boundaries without realizing it.
- this sorta goes against "make the pit of success the obvious path" ideology
- this is more the inverse which still holds in that the obvious path should be successful


the 3 ways to solve this are:
	1. make the transaction abstraction the registry system with revivable transactions.
	 - silently allows async boundaries by opening new transactions with the same scope as the original
	 - is an anti pattern in that:
	  - it hides control flow from the surface api
		- operations after the async boundary may require a lesser scope
		 - requiring an objectstore w/ write perms in transactionA's scope (even when unused by the transaction) prevents transactionB from also accessing the store w/ write perms
	2. try to make an easier path
	 - The number 1 way to guide a consumer would be to not allow for Transaction layers to be blanket provided at comp time with a typescript error. (not possible)
	 - barring that; an obvious runtime error that the user violated the indexeddb requirement of maintaining the event loop when making a transaction.
	 - the ultimate goal is the make the obvious path providing a transaction layer locally at each program that interacts with the database via object stores.
	 - if the user/consumer reads docs this is easy; you just make the quick start guide show example providing the transaction layer locally (likely through the TaggedIDBObjectStoreService helper) and you can link to the why and the how for those who care.
	 - in this case we dont need to worry about make the the transaction abstraction "smart" or anything.
	  - it doesnt have to care about resuming transaction or any of its pitfalls
	 - you can simply also provide as part of the quick start guide a snippet of the "do async work outside the transaction" comment.
	 - you hide the IDBTransactionService in the docs and make sure the obvious way to get provide transaction is with the `.WithReadWrite`|`.WithReadOnly` tagged object store helpers
	  - you make these helper always build `.fresh` layers
		- this gives the illusion that each provided layer is a new transaction, and it is but only because we are explicitly creating a fresh layer and hiding that from the user.
		 - best to keep "Fresh" in the naming to make a connection for effect users
		- making this path correct would require removing the non fresh layer helpers.
		 - the exist hatch is already using a base IDBTransactionService layer + `.Default`
	3. do 
	
In Effect land, cached by default layers make sense because services are _usually_ stateless (and in cases where theyre stateful/dynamic, theyre usually not cached).
But, an IDB transaction is inherently stateful and time-bounded

So we want users to be using fresh layers by default.

### some example code snippets to illustrate the gap in the mental model from the raw indexeddb transaction api and the effect layer transaction abstraction, and the expectations around it
```ts
// what do you think should happen?
// which if any should have atomic garuntees?
yield* Effect.gen(function*() {
	const objectStoreA = yield* ObjectStoreA
	const objectStoreB = yield* ObjectStoreB
  yield* objectStoreA.write(data)
	yield* Effect.sleep("1 millis") // async work mid transaction
  yield* objectStoreB.write(data)
}).pipe(Effect.provide(IndexedDbTransaction.FreshReadWrite))

yield* Effect.gen(function*() {
	const objectStoreA = yield* ObjectStoreA
	const objectStoreB = yield* ObjectStoreB
	yield* Effect.sleep("1 millis") // async work before any transaction work
  yield* objectStoreA.write(data)
  yield* objectStoreB.write(data)
}).pipe(Effect.provide(IndexedDbTransaction.FreshReadWrite))

yield* Effect.gen(function*() {
	yield* Effect.sleep("1 millis") // async work before object stores are accessed
	const objectStoreA = yield* ObjectStoreA
	const objectStoreB = yield* ObjectStoreB
  yield* objectStoreA.write(data)
  yield* objectStoreB.write(data)
}).pipe(Effect.provide(IndexedDbTransaction.FreshReadWrite))

yield* Effect.gen(function*() {
	const objectStoreA = yield* ObjectStoreA
	const objectStoreB = yield* ObjectStoreB
  yield* objectStoreA.write(data)
  yield* objectStoreB.write(data)
	yield* Effect.sleep("1 millis") // async work after transaction work
}).pipe(Effect.provide(IndexedDbTransaction.FreshReadWrite))


```
With the lazy requesting of an idb transaction you can allow async work before (and naturally, after) any atomic transaction work.
But once you interact with the database via the object store services, you open the transaction, and-
all atomic work done thereafter must be synchronous, because idb transactions will commit as soon as you yield to the event loop.


Allowing for colocation of async resource gathering in your transaction programs is an nice dx gain over raw IDB and promise-based libraries.
  - In those you have to be deliberate about transaction scope before you open it
	- you can't do any async work before calling db.transaction() if you want to use the result. 

with lazy opening of transaction you can structure your programs more naturally:
```ts
const program = Effect.gen(function*() {
  const config = yield* fetchConfig()     // async before
  const store = yield* WorkoutStore
  yield* store.write(config.data)         // transaction opens here
																					// other synchronous work/transaction interactions here
																					// v

	// finally, allow the transaction to auto commit by doing async work or just ending the program
	yield* Effect.sleep("1 millis")
}).pipe(Effect.provide(WorkoutStore.WithFreshReadWrite))
```
The transaction scope concerns are handled by the layer helpers

Alternatively, opening the transaction eagerly at layer build time would force users to restructure programs-
so that all async work happens outside the provide transaction scope.

```ts
const config = yield* fetchConfig() // async must be outside because .WithFreshReadWrite opens transaction eagerly
const program = yield* Effect.gen(function*() {
	yield* Effect.sleep("1 millis")	// 💀 any async work inside this program would commit the txn
  const store = yield* WorkoutStore
  yield* store.write(config.data)
}).pipe(Effect.provide(WorkoutStore.WithFreshReadWrite))
```

The hardest thing will be to guide users towards a natural understanding that a program with async work between object store operations-
 within the same transaction layer, will commit and make the underlying idb transaction handle no longer usable by the future object store operations in that program.

On of the ~~best~~ things about about eager transaction opening is that ANY async work encountered in a program that a IDBTransactionService layer is provided for,
would instantly commit its back transaction, leading to alot of "TransactionNotFound" errors for users who dont know about the indexeddb transacation lifetime semantics
 - at the cost of a footgun heavy shitty dx, users would learn eventually "oh i cant do any async work inside of this transaction service layer"

While lazily requesting a native transaction from the database does allow for async work up to the point that actual db interaction is required.
 - it complicates the mental model.
  - users may ask why does this sometimes work and sometimes causes the transaction to become unusable

## The current system

The IDBTransactionService is closer to the registry abstraction.
 - on layer build it doesnt create a transaction handler right away
   - it instead creates a registry of object stores names (registered by the object store layers when they build)
	 - whenever an object store method is called the registry provisions a transaction
	 - user is expected to complete all transaction work synchronously after the first object store method is called.
	 - doing async work and attempting to reuse an object stores method will result in an error:
	 		IDBTransactionGetObjectStoreError: Sync error getting object store from transaction. InvalidStateError: Failed to execute 'objectStore' on 'IDBTransaction': The transaction has finished.

TaggedIDBObjectStoreService helpers provide cached layers by default
 - follows effect's mental model where the easy path for layers is cache by default
 - user can use the `.WithFresh*` variants to provide non shared/cached transaction registries.
 - this adds friction when wanting to be explicit about obtaining two separate transaction objects (ie concurrent readonly transactions) for two seperate subprograms in the same program
  - providing both with `ObjectStore.WithReadOnly` end up causing them to share the same memomap entries for `IDBTransactionService.ReadOnly` resulting in a single transaction for both programs (opposite of intended)
 - Again its hard to make people default to knowing to use the `Layer.fresh` for this guarantee.

Expectations is for fresh Transactions to be provided where a layer is constructed. (ie every transaction is fresh)
 - this is currently not backed by implementation
 - escape hatch already exists with `IDBTransactionService.make()` for a manual pinnable/re-usable transaction handle


# The goal for the current system

- Keep the mental model of "1 provided layer = 1 transaction" scope.
	- If user creates an effect program and satisfies the layer requirements with a single provision-
		then the transaction erroring with "TransactionInactiveError" (or similar) across async boundaries should be the expected behavior.
	- heavily inform users that because of intrinsic idb transaction lifetime properties all async work should be done outside of atomic transaction work.
	- make all helpers for providing transaction layers default to fresh layers, keep & document an escape hatch.

- Keep the indexeddb transaction lazily requested
 - allows for ability to async work inside of the transaction layer scope, but before the native idb transaction is opened.
 - allows for better ergonomics around Effect layer composition and deducing transaction scope from the surface api
  - ie the `IDBTransactionService` can register object stores for a transaction scope during layer build phase.
	- **reads from bottom up**
	```ts
	const data = yield* fetch("https://...")
	yield* Effect.gen(function*() { // <-  4. program is ran
		const objectStoreA = yield* ObjectStoreA
		const objectStoreB = yield* ObjectStoreB
		yield* objectStoreA.write(data) // <- 5. object store accessed -> a `transaction("readwrite", ["objectStoreA", "objectStoreB"])`requested from idb
		yield* objectStoreB.write(data)
	}.pipe(
		Effect.provide( // <- 3. Layer fished building
			Layer.provide(
				Layer.merge(ObjectStoreA.Default, ObjectStoreB.Default), // 2. IDBObjectStoreService layers register their store names
				IDBTransactionService.FreshReadWrite // <- 1. sets up a fresh layer with a "readwrite" scoped registry
			)
	)))
	```
 - notably adds a layer of hidden control flow between the libs surface apis and their respective idb apis.
	- ie; `yield* objectStoreA.add(data)` is **not** purely an effect-ful wrapper over `const objectStoreA = tx.objectStore("A"); objectStoreA.add(data)`
		- it also has a hidden side effects for setting up the backing transaction service and underlying `tx`. (where `tx` is the native idb transaction handle)
	- It arguably makes the transaction lifetime less predictable.
		- A user reading the code can't tell when the transaction actually opens without knowing the lazy open rule

---
