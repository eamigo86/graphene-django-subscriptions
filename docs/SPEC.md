# SPEC — Modernization of `graphene-django-subscriptions`

**Status:** DRAFT — pending approval
**Version target:** `0.1.0` (first modern release; see §13 Versioning)
**Author:** Migration spec
**Date:** 2026-06-05

This is a **spec-driven-development (SDD)** document. It is the contract that the
implementation and the test suite must satisfy. Nothing in `graphene_django_subscriptions/`
should be changed until this document is approved. Once approved, every acceptance
criterion in §11 must be backed by at least one automated test in §12.

---

## 1. Overview, Goals & Non-Goals

### 1.1 Context

`graphene-django-subscriptions` adds GraphQL subscription support to `graphene-django`
on top of Django Channels. The current code targets a **Channels 1.x** world that no
longer exists:

- `channels-api` (the broadcast/binding engine) is **deprecated** and Channels-1-only.
- `from channels import Group`, `WebsocketDemultiplexer`, `reply_channel`, `route_class`
  were **removed** in Channels 2+.
- `rx.Observable` (RxPY 1) is the graphene-2 subscription mechanism; graphene 3 uses
  **async generators**.
- `six` / `promise` / `string_types` are Python-2-era.

The companion package **`graphene-django-extras` 1.1.0** (same author, Jan 2026) already
runs on **graphene 3 / graphene-django 3.2+ / Python ≥ 3.12 / Django 4.0–6.0**. This
package must converge on the **same stack** to remain usable alongside it.

### 1.2 Goals

- **G1** — Run on modern stacks: Python ≥ 3.12, Django ≥ 4.0 (incl. 5.x and 6.0),
  graphene-django ≥ 3.2, Channels ≥ 4.0, modern `djangorestframework` and `django-filter`.
- **G2** — **Preserve the public-facing API**: the developer-facing Python API
  (`Subscription` subclass, `Meta.serializer_class`/`stream`, `.Field()`, the generated
  enums) **and** the wire protocol (the `channel_id` handshake, the GraphQL subscription
  request arguments, and the notification JSON payload). See §4 and §5.
- **G3** — Replace `channels-api` with a **native, in-house** broadcast engine built on
  Django signals + the Channels channel layer.
- **G4** — Maximize performance and concurrency (async consumer, O(1) fan-out per event).
- **G5** — Fix latent correctness bugs without changing the public contract (see §10).
- **G6** — Ship a rigorous automated test suite and CI matrix (§12, §13).

### 1.3 Non-Goals

- **NG1** — Implementing the Apollo `graphql-ws` / `graphql-transport-ws` protocol. (May
  be a future addition; explicitly out of scope here — the legacy protocol is preserved.)
- **NG2** — Changing the GraphQL schema-facing semantics of subscriptions (argument names,
  enums, payload shape) beyond what §10 fixes require.
- **NG3** — Supporting Python 2 or Channels < 4 or graphene < 3.
- **NG4** — Providing a generic CRUD-over-websocket layer (the `channels-api`
  `ResourceBinding` inbound CRUD feature). Only the subscription/broadcast half is ported.

---

## 2. Target Compatibility Matrix

| Component            | Constraint                         | Notes                                              |
|---------------------|-------------------------------------|----------------------------------------------------|
| Python              | `>=3.12,<4.0`                       | Aligns with `graphene-django-extras` 1.1.0         |
| Django              | `>=4.0,<7.0`                        | Test 4.0, 4.2 (LTS), 5.0, 5.2 (LTS), 6.0           |
| Channels            | `>=4.0,<5.0`                        | ASGI consumers, channel layers                     |
| graphene            | `>=3.1,<4.0`                        | Pulled via graphene-django                         |
| graphene-django     | `>=3.2,<4.0`                        | graphene-3 era                                     |
| graphql-core        | `>=3.2,<3.3`                        | Transitive; `subscribe()` async path               |
| djangorestframework | `>=3.14`                            | Serializers only                                   |
| django-filter       | `>=23.0`                            | "Modern django-filters" per request; ecosystem use |
| graphene-django-extras | `>=1.1.0` (companion, optional dep) | Not a hard runtime import; documented pairing    |
| channels-redis      | optional extra `[redis]`            | Required for multi-process production (see §6.6)   |

**Dependencies removed:** `channels-api`, `rx`, `six`, `promise`.

---

## 3. Architecture: Old → New Mapping

The Channels 1.x model maps almost 1:1 onto Channels 4, which is what makes preserving
the public protocol feasible.

| Channels 1.x (current)                          | Channels 4 (new)                                                |
|-------------------------------------------------|-----------------------------------------------------------------|
| `message.reply_channel` (per-connection)        | `consumer.channel_name` (per-connection)                        |
| `Group(name).add(reply_channel)`                | `async_to_sync(channel_layer.group_add)(name, channel_name)`   |
| `Group(name).discard(reply_channel)`            | `async_to_sync(channel_layer.group_discard)(name, channel_name)`|
| `Group(name).send({"text": ...})`               | `async_to_sync(channel_layer.group_send)(name, event)`         |
| `WebsocketDemultiplexer` (`channels.generic`)   | `AsyncJsonWebsocketConsumer` subclass                          |
| `channels_api` `ResourceBinding` (signals→group)| In-house `SubscriptionBinding` (signals→`group_send`)          |
| `route_class(Demux)` + `CHANNEL_LAYERS.ROUTING` | `ProtocolTypeRouter`/`URLRouter` + `ASGI_APPLICATION`          |
| `rx.Observable.from_([conf])` (graphene 2)      | `async def subscribe_*` async generator yielding one `conf`     |
| `depromise_subscription` middleware             | `SubscriptionGraphQLView` HTTP executor (drives one yield)      |

**Two-channel flow (preserved):**

1. **Handshake (WS):** client connects to the WS endpoint; server `accept()`s and sends
   `{"channel_id": "<token>", "connect": "success"}`.
2. **Subscribe (HTTP):** client POSTs a GraphQL `subscription{ … }` to the normal HTTP
   GraphQL endpoint, echoing `channelId`. The resolver joins/leaves the relevant group(s)
   for that channel and returns a one-shot confirmation `{ ok, error, stream, … }`.
3. **Notify (WS):** when a watched model instance is created/updated/deleted, the binding
   broadcasts the serialized payload to the group; every subscribed connection receives it
   over its WS.

> The channel layer must be **cross-process capable** (Redis) when HTTP workers and WS
> workers run in separate processes — exactly as the old design required a non-inmemory
> backend. `InMemoryChannelLayer` works only single-process (dev/tests). See §6.6.

---

## 4. Public API Contract (developer-facing)

The following symbols and their shapes are **preserved**. Behavioural changes are limited
to those listed in §8 and §10.

### 4.1 `graphene_django_subscriptions.subscription.Subscription`

Abstract `ObjectType`. Subclassed via `Meta`:

```python
class UserSubscription(Subscription):
    class Meta:
        serializer_class = UserSerializer   # required; DRF Serializer subclass
        stream = "users"                     # required; str
        queryset = None                      # optional; must match serializer model
        description = "User Subscription"    # optional
```

Preserved output fields (unchanged): `ok: Boolean`, `error: String`, `stream: String`,
`operation: OperationSubscriptionEnum`, `action: ActionSubscriptionEnum`.

Preserved generated argument set on `.Field()` (unchanged names & semantics):

| Arg          | Type                          | Req | Meaning                                              |
|--------------|-------------------------------|-----|------------------------------------------------------|
| `channelId`  | `String`                      | yes | Connection token from the handshake                  |
| `action`     | `ActionSubscriptionEnum`      | yes | `CREATE` / `UPDATE` / `DELETE` / `ALL_ACTIONS`       |
| `operation`  | `OperationSubscriptionEnum`   | yes | `SUBSCRIBE` / `UNSUBSCRIBE`                           |
| `id`         | `ID`                          | no  | Instance id to scope the subscription                |
| `data`       | `[<Model>FieldsEnum]`         | no  | Fields to include in notifications                   |

Preserved enums (unchanged values):

- `ActionSubscriptionEnum = {CREATE, UPDATE, DELETE, ALL_ACTIONS}`
- `OperationSubscriptionEnum = {SUBSCRIBE, UNSUBSCRIBE}`
- `<Model>Fields` — auto-generated from the serializer field names (UPPER_SNAKE → snake),
  same algorithm as today (`subscription.py:78-82`).

Preserved classmethods (signatures kept): `Field(cls, *args, **kwargs)`,
`model_label(cls)`, `_group_name(cls, action, id=None)`, `get_binding(cls)`.

> `subscription_resolver` (the synchronous graphene-2 resolver) is **replaced internally**
> by an async `subscribe_*` generator + the HTTP executor (§6.3). It is not part of the
> documented public API, but a compat wrapper is kept where cheap (§8).

### 4.2 `graphene_django_subscriptions.consumers.GraphqlAPIDemultiplexer`

Preserved as the base WS consumer users subclass. New base class is an
`AsyncJsonWebsocketConsumer`. Users still declare a stream→subscription mapping:

```python
class CustomAppDemultiplexer(GraphqlAPIDemultiplexer):
    subscriptions = {                 # preferred name
        "users": UserSubscription,
        "groups": GroupSubscription,
    }
    # `consumers = {...: Sub.get_binding().consumer}` accepted as a deprecated alias (§8)
```

On `connect`: accept + send the `{"channel_id", "connect"}` frame (§5.1). The consumer
registers the signal bindings for its subscriptions on first use (idempotent).

### 4.3 `get_binding()`

Returns a `SubscriptionBinding` bound to `(model, stream, serializer_class, queryset)`.
Calling it wires the broadcast signal handlers for that model (idempotent). The legacy
`.consumer` attribute is preserved as a deprecated alias that resolves to the demultiplexer
mapping target (§8).

### 4.4 Module exports (`__init__.py`)

`__all__` keeps `Subscription`, `GraphqlAPIDemultiplexer`. `depromise_subscription` is
kept as a deprecated no-op shim (§8); `SubscriptionGraphQLView` is added (§6.3).

---

## 5. Wire Protocol Contract (preserved)

### 5.1 Handshake frame (server → client, on WS connect)

```json
{ "channel_id": "<opaque-token>", "connect": "success" }
```

- `channel_id` is **opaque** to the client (stored and echoed back). Its concrete value
  changes from the legacy `reply_channel` suffix to the Channels-4 `channel_name` (or a
  token deterministically resolvable to it). This is a permitted change because the README
  already specifies the value is stored and reused as an opaque handle.

### 5.2 Subscribe / unsubscribe request (client → server, over HTTP GraphQL)

```graphql
subscription {
  userSubscription(
    action: UPDATE,
    operation: SUBSCRIBE,
    channelId: "<opaque-token>",
    id: 5,
    data: [ID, USERNAME, FIRST_NAME, LAST_NAME, EMAIL]
  ) { ok error stream }
}
```

Synchronous one-shot response (unchanged shape):

```json
{ "data": { "userSubscription": { "ok": true, "error": null, "stream": "users" } } }
```

### 5.3 Notification frame (server → client, over WS)

```json
{
  "stream": "users",
  "payload": {
    "action": "update",
    "model": "auth.user",
    "data": { "id": 5, "username": "meaghan90", "email": "meaghan@gmail.com" }
  }
}
```

- `data` is filtered to the fields requested in the subscribe `data` argument, **per
  connection** (correctness fix, §10.1). When `data` is omitted, the full serializer
  output is sent.

### 5.4 Group naming (preserved)

```
<app_label>.<model_name>-<action>          # action-wide
<app_label>.<model_name>-<action>-<id>      # instance-scoped
```

`ALL_ACTIONS` subscribes/unsubscribes to the `create`, `update`, `delete` group variants.
Group names must satisfy the Channels group-name charset (`[A-Za-z0-9._-]`, ≤ 100 chars);
the existing scheme already complies. Long/invalid model labels are hashed (§6.4).

---

## 6. Component Design

### 6.1 `Subscription` type

- Keep `__init_subclass_with_meta__` validation (serializer subclass check, stream string
  check, queryset/serializer model match) and enum/argument generation verbatim.
- Drop `six.string_types` → `str`.
- The per-subscription requested-field set is **not** stored on the shared
  `serializer_class.Meta` (that is the §10.1 race). It is carried through the subscribe
  control message to the consumer (§6.5).

### 6.2 Broadcast engine — `SubscriptionBinding` (replaces `channels-api`)

For each `(model, stream, serializer_class)`:

- Connect `post_save` and `post_delete` receivers (deduplicated by a registry keyed on
  `(model, stream)`; weak=False, with a stable `dispatch_uid`).
- `post_save`: `action = "create" if created else "update"`.
- `post_delete`: `action = "delete"`.
- On signal:
  1. Serialize the instance **once**: `serializer_class(instance).data`.
  2. Build payload `{"action", "model": model_label, "data": <full data>}`.
  3. `group_send` to **two** groups: `"<label>-<action>"` and `"<label>-<action>-<pk>"`,
     with an event `{"type": "subscription.notify", "stream": stream, "payload": payload}`.
- Fan-out is O(1) sends per event from the producer's perspective; the channel layer does
  the multiplexing. Field filtering happens at the consumer (§6.5), so the instance is
  serialized once regardless of subscriber count.

> Rationale for full-serialize-once + filter-at-consumer: different subscribers request
> different `data` field sets for the same group. Serializing per subscriber (the only
> correct alternative that filters at the producer) would be O(subscribers). We trade a
> few extra bytes over the channel layer for a single serialization and correct
> per-connection projection.

### 6.3 HTTP subscription executor — `SubscriptionGraphQLView`

graphene-django's `GraphQLView` does not execute subscription operations. We provide a
`GraphQLView` subclass that, when `operation == "subscription"`:

1. Calls graphql-core `subscribe(schema, document, …)` (async).
2. Drives the returned async iterator for **exactly one** value via `async_to_sync`
   (`anext`), then closes it (`aclose`).
3. Returns that first `ExecutionResult` as the HTTP response.

The side effects (group join/leave) are performed inside the `subscribe_*` generator
before the single `yield`. This reproduces the legacy "subscribe over HTTP returns a
confirmation" behavior. The view is the documented replacement for the
`depromise_subscription` middleware.

### 6.4 `subscribe_*` async generator (per subscription field)

`Subscription.Field()` wires an async generator resolver that:

1. Reads `action`, `operation`, `channel_id`, `id`, `data` from kwargs.
2. Resolves the target channel name from `channel_id`.
3. For `ALL_ACTIONS`, iterates `("create","update","delete")`; else uses `action`.
4. `SUBSCRIBE` → `group_add(group, channel_name)` and send a register control message
   carrying the requested `data` fields (§6.5). `UNSUBSCRIBE` → `group_discard` + a
   deregister control message.
5. `yield cls(ok=True, error=None, stream=…, operation=…, action=…)` exactly once, then
   return. On exception, yield `ok=False, error=str(e)`.

Group-name building reuses `_group_name`; over-long/invalid labels are length-checked and
hashed to stay within the Channels group-name limit (defensive; current scheme already
fits common cases).

### 6.5 Per-connection field selection (correctness)

The requested `data` fields cannot be stored on the shared serializer class. Instead:

- On `SUBSCRIBE`, the resolver `channel_layer.send(channel_name, {"type":
  "subscription.register", "group": g, "fields": [...]})`.
- The consumer keeps `self._fields: dict[group_name, list[str] | None]`.
- In the `subscription_notify` handler, the consumer filters `payload["data"]` to the
  fields registered for that group before `self.send_json(...)`. `None`/empty ⇒ full data.
- On `UNSUBSCRIBE`, a `subscription.deregister` message clears the entry.

This is cross-process safe because `channel_layer.send(channel_name, …)` routes to the
specific WS consumer regardless of which process the HTTP resolver ran in.

### 6.6 Consumer — `GraphqlAPIDemultiplexer`

- `AsyncJsonWebsocketConsumer`.
- `connect`: `await self.accept()`, compute `channel_id` from `self.channel_name`, send the
  handshake frame, ensure each declared subscription's `SubscriptionBinding` is registered.
- `subscription_notify(event)`: filter per §6.5, `await self.send_json({"stream", "payload"})`.
- `subscription_register` / `subscription_deregister`: update `self._fields`.
- `disconnect`: groups are cleaned by the channel layer on channel expiry; we also best-
  effort `group_discard` for known groups.

### 6.7 Routing & settings (user-facing migration)

Old (`CHANNEL_LAYERS["default"]["ROUTING"]`, `route_class`) → new ASGI:

```python
# asgi.py
application = ProtocolTypeRouter({
    "http": django_asgi_app,
    "websocket": URLRouter([ re_path(r"^ws/graphql/$", CustomAppDemultiplexer.as_asgi()) ]),
})
# settings.py
ASGI_APPLICATION = "myproject.asgi.application"
CHANNEL_LAYERS = {"default": {"BACKEND": "channels_redis.core.RedisChannelLayer",
                              "CONFIG": {"hosts": [("127.0.0.1", 6379)]}}}
```

This delta is documented in the migration guide (§9) and the rewritten README.

---

## 7. File-level Plan (implementation map — informational)

| File                       | Change                                                                  |
|----------------------------|-------------------------------------------------------------------------|
| `subscription.py`          | graphene-3 type; async `subscribe_*`; drop `rx`/`six`/`copy reply_channel` |
| `consumers.py`             | `AsyncJsonWebsocketConsumer` demultiplexer + handlers                    |
| `bindings.py`              | in-house `SubscriptionBinding` (signals) replacing channels-api          |
| `mixins.py`                | keep serialize/deserialize helpers; drop `channels_api`/`Group` imports  |
| `middleware.py`            | `depromise_subscription` → deprecated shim; logic moves to the view      |
| `views.py` (new)           | `SubscriptionGraphQLView`                                                |
| `__init__.py`              | exports + version bump                                                   |
| `pyproject.toml` (new)     | replace `setup.py`/`setup.cfg`; modern metadata & deps                   |
| `tests/` (new)             | full suite (§12)                                                         |
| `.github/workflows/ci.yml` (new) | matrix CI (§13)                                                    |
| `README.*`                 | rewrite for the new stack & migration guide                              |

---

## 8. Backward-Compatibility & Deprecations

- **Preserved as-is:** `Subscription` (Meta keys, enums, args, output fields, `.Field()`,
  `model_label`, `_group_name`, `get_binding`), `GraphqlAPIDemultiplexer` name and the
  stream→subscription mapping concept, the wire protocol of §5.
- **Deprecated (kept working with `DeprecationWarning`):**
  - `consumers = {stream: Sub.get_binding().consumer}` mapping form → use `subscriptions
    = {stream: Sub}`. The `.consumer` attribute resolves to a binding handle so the old
    form still wires correctly.
  - `depromise_subscription` middleware → no-op shim; replaced by `SubscriptionGraphQLView`.
- **Breaking (documented, unavoidable):**
  - `CHANNEL_LAYERS[...]["ROUTING"]` + `route_class` → ASGI `ProtocolTypeRouter`/`URLRouter`
    + `ASGI_APPLICATION` (Channels-4 requirement, not under our control).
  - `info.context.reply_channel` is gone; the resolver uses `channelId` + channel layer.
  - Python 2 / graphene 2 / Channels < 4 no longer supported.

A `CHANGELOG`/README "Migration from 0.0.x" section enumerates each item with before/after.

---

## 9. Migration Guide (for end users) — outline

1. Bump deps; remove `channels_api` from `INSTALLED_APPS`.
2. Replace `routing.py` + `CHANNEL_LAYERS.ROUTING` with `asgi.py` + `ASGI_APPLICATION`.
3. Replace the `GRAPHENE.MIDDLEWARE` `depromise_subscription` entry with the
   `SubscriptionGraphQLView` URL.
4. Rename `consumers={...get_binding().consumer}` → `subscriptions={... : Sub}` (optional;
   old form warns but works).
5. Configure a Redis channel layer for multi-process deployments.

---

## 10. Correctness / Security Fixes (no public-contract change)

- **10.1 `only_fields` global mutation race.** Today `subscription_resolver` does
  `setattr(cls._meta.serializer_class.Meta, "only_fields", data)` — shared mutable state,
  last-writer-wins across all connections, a real concurrency bug. Fixed by per-connection
  field selection (§6.5). Public `data` argument and payload shape are unchanged.
- **10.2 Broad `except Exception`.** Preserve the public contract (errors surface in the
  `error` field) but log via `logging` and avoid swallowing `BaseException`.
- **10.3 Group-name validation.** Enforce the Channels charset/length; hash overflowing
  labels to prevent silent channel-layer failures.
- **10.4 Signal handler idempotency.** Deduplicate binding registration via `dispatch_uid`
  to avoid duplicate notifications when a demultiplexer is instantiated repeatedly.

---

## 11. Acceptance Criteria

Each is testable (§12 cross-refs in brackets).

- **AC1** Package imports and `Subscription` subclasses build a valid schema on
  Python 3.12+, Django ≥4.0, graphene-django ≥3.2 with **no** `rx`/`six`/`promise`/
  `channels_api` imports anywhere. [T-UNIT, T-IMPORT]
- **AC2** WS connect yields `{"channel_id": <str>, "connect": "success"}`. [T-CONSUMER]
- **AC3** A `subscription{…operation: SUBSCRIBE…}` over the HTTP view returns
  `{ok: true, error: null, stream: <stream>}` and adds `channel_name` to the correct
  group(s). [T-RESOLVER, T-E2E]
- **AC4** After subscribing to `UPDATE id:5`, saving instance 5 delivers a WS frame
  matching §5.3 with `action:"update"`, `model:"<label>"`, and `data` filtered to the
  requested fields. [T-E2E]
- **AC5** `CREATE`/`DELETE`/`ALL_ACTIONS` deliver on the corresponding model events; other
  actions do not. [T-E2E]
- **AC6** `UNSUBSCRIBE` removes group membership; subsequent events deliver nothing. [T-E2E]
- **AC7** Omitting `data` delivers the full serializer payload; two connections with
  different `data` sets on the same group each receive their own projection (proves §10.1
  is fixed). [T-E2E, T-CONCURRENCY]
- **AC8** Generated `<Model>Fields` enum and `Action`/`Operation` enums match the legacy
  values (snapshot). [T-UNIT]
- **AC9** Deprecated `consumers={….consumer}` form and `depromise_subscription` import keep
  working and emit `DeprecationWarning`. [T-COMPAT]
- **AC10** CI passes across the full version matrix (§13). [CI]

---

## 12. Test Plan

Stack: `pytest`, `pytest-django`, `pytest-asyncio`, Channels `WebsocketCommunicator`,
`InMemoryChannelLayer`, a tiny test app with `auth.User`-like model + DRF serializer.

| ID            | Scope        | What it asserts                                                        |
|---------------|--------------|-----------------------------------------------------------------------|
| T-IMPORT      | static       | No forbidden imports (`rx`,`six`,`promise`,`channels_api`); `__all__`. |
| T-UNIT        | unit         | `_group_name`, `model_label`, enum generation, field-filter helper.   |
| T-CONSUMER    | channels     | connect handshake; `notify`/`register`/`deregister` handlers.         |
| T-RESOLVER    | unit/async   | `subscribe_*` performs group add/discard + control msg; one yield.    |
| T-VIEW        | http         | `SubscriptionGraphQLView` returns the one-shot confirmation.          |
| T-E2E         | integration  | open WS → subscribe via view → save/delete model → assert WS frame.   |
| T-CONCURRENCY | integration  | two connections, different `data` sets, correct per-connection output.|
| T-COMPAT      | regression   | deprecated forms still wire and warn.                                  |
| T-BINDING     | unit         | signal dedup (`dispatch_uid`); single serialize per event.            |

Coverage gate: ≥ 90% on the package modules. Every AC in §11 maps to ≥ 1 test above.

---

## 13. Packaging, CI & Versioning

- **Packaging:** migrate `setup.py`/`setup.cfg` → `pyproject.toml` (PEP 621), `hatchling`
  or `setuptools` backend; declare extras `[redis]` (channels-redis) and `[test]`.
- **CI:** GitHub Actions matrix — Python {3.12, 3.13} × Django {4.0, 4.2, 5.2, 6.0}
  (drop illegal combos), using `nox`/`tox`; run lint (`ruff`), type-light check, tests +
  coverage. Add `ruff`/`black` formatting check.
- **Versioning:** first modern release is **`0.1.0`** (signals a real break from the
  `0.0.x` Channels-1 line while staying pre-1.0). README documents the support boundary.

---

## 14. Risks & Open Questions

- **R1 — HTTP-resolved subscription is non-standard.** Preserved per decision, but it
  requires a shared channel layer across HTTP+WS processes. Documented (§6.6). Mitigation:
  ship clear settings guidance; default dev config uses InMemory.
- **R2 — graphene-django `GraphQLView` internals** for `SubscriptionGraphQLView` may shift
  across 3.x minors. Mitigation: target the documented `subscribe()` path of graphql-core,
  not private graphene-django internals; pin tested versions in CI.
- **R3 — Field projection over the channel layer** sends full data on the wire. Acceptable
  for typical model sizes; revisit with a producer-side cache if profiling shows pressure.
- **OQ1 — `channel_id` token format:** use `self.channel_name` directly (simplest) vs. a
  short opaque token mapped to it. Proposed: use `channel_name` directly. (Confirm in impl.)
- **OQ2 — Minimum Django:** request says ≥4.0; 4.0 is EOL upstream. Keep 4.0 in the
  declared floor but only CI-test 4.2+/5.x/6.0? Proposed: floor `>=4.2` in CI, allow 4.0
  install. (Confirm.)

---

## 15. Definition of Done

1. This SPEC approved.
2. All §11 acceptance criteria implemented and green via §12 tests.
3. CI matrix (§13) green.
4. README + migration guide rewritten.
5. No forbidden legacy imports remain.
6. Changes committed and pushed to
   `claude/graphql-subscriptions-channels-upgrade-xsY7w`.
