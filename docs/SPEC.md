# SPEC — GraphQL Subscriptions as an optional `graphene-django-extras[subscriptions]` extra

**Status:** DRAFT — pending approval
**Decision baseline (approved):**
- Wire protocol: **preserve** the current model (`channel_id` handshake + HTTP-resolved subscribe), reimplemented on Channels 4.
- Engine: **native in-house** (Django signals + Channels channel layer); drop `channels-api`.
- Packaging: **merge** subscriptions into `graphene-django-extras` as an optional
  `[subscriptions]` extra; keep `graphene-django-subscriptions` as a **deprecated
  compatibility shim**.
- Process: **SDD** — this document is the contract; no code until approved.

**Target release:** `graphene-django-extras 1.2.0` (adds the `subscriptions` extra) +
`graphene-django-subscriptions 0.1.0` (final, shim-only).
**Date:** 2026-06-05

---

## 1. Overview, Goals & Non-Goals

### 1.1 Context

`graphene-django-subscriptions` adds GraphQL subscriptions to `graphene-django` on top of
Django Channels. Its current code targets a **Channels 1.x** world that no longer exists
(`channels-api` deprecated; `Group`/`WebsocketDemultiplexer`/`reply_channel`/`route_class`
removed; `rx`/`six`/`promise` are Python-2/graphene-2 era).

The companion **`graphene-django-extras` 1.1.0** (same author) already runs on the modern
stack and — critically — **already depends on `djangorestframework`** (it powers
`DjangoSerializerType`/`DjangoSerializerMutation`). Subscriptions are built on the very
same `serializer_class` abstraction. Confirmed facts about extras 1.1.0:

- Build: **Poetry** (`poetry-core>=1.0.0`). Python `>=3.12,<4.0`. Django `>=4.0,<7.0`.
- Deps: `graphene-django ^3.2`, `djangorestframework ^3`, `django-filter >=22.1`,
  `python-dateutil`.
- **No** `channels` / `channels-redis` → these become the new optional extra.

Therefore subscriptions are merged into extras as an **opt-in** feature: base users get
zero new dependencies; subscription users opt in via the `subscriptions` extra.

### 1.2 Goals

- **G1** — Modern stack: Python ≥ 3.12, Django ≥ 4.0 (incl. 5.x, 6.0), graphene-django
  ≥ 3.2, Channels ≥ 4.0, modern DRF and `django-filter`.
- **G2** — Install UX:
  - `pip install graphene-django-extras` / `uv add graphene-django-extras` → **no**
    `channels`/`channels-redis`; importing `graphene_django_extras` never imports channels.
  - `pip install "graphene-django-extras[subscriptions]"` / `uv add
    "graphene-django-extras[subscriptions]"` → enables subscriptions.
- **G3** — **Preserve the public API**: the developer-facing Python API (`Subscription`
  subclass, `Meta.serializer_class`/`stream`, `.Field()`, generated enums) and the wire
  protocol (handshake, subscribe arguments, notification payload). Old import paths keep
  working through the shim (§5).
- **G4** — Native in-house broadcast engine replacing `channels-api` (§7.2).
- **G5** — Maximize performance/concurrency (async consumer, O(1) fan-out per event).
- **G6** — Fix latent correctness bugs without changing the public contract (§11).
- **G7** — Rigorous automated tests + CI matrix that proves base install stays
  channels-free (§13, §14).

### 1.3 Non-Goals

- **NG1** — Apollo `graphql-ws`/`graphql-transport-ws` protocol (future; legacy protocol
  preserved here).
- **NG2** — Changing subscription schema semantics beyond the §11 correctness fixes.
- **NG3** — Python 2 / Channels < 4 / graphene < 3.
- **NG4** — Porting the `channels-api` inbound CRUD-over-websocket feature (only the
  subscription/broadcast half is ported).

---

## 2. Deliverables & Repositories

Two repos are touched. **Implementation requires adding the `graphene-django-extras` repo
to this session's scope** (currently only `graphene-django-subscriptions` is in scope).

| Repo | Role after this work |
|------|----------------------|
| `eamigo86/graphene-django-extras` | **Primary.** New `graphene_django_extras/subscriptions/` package; `[subscriptions]` extra in `pyproject.toml`; tests; docs. Released as `1.2.0`. |
| `eamigo86/graphene-django-subscriptions` | **Shim.** Stripped to a thin compatibility package that depends on `graphene-django-extras[subscriptions]` and re-exports symbols with `DeprecationWarning`. Released as `0.1.0` (final). Hosts this SPEC under `docs/`. |

---

## 3. Target Compatibility Matrix

| Component            | Constraint        | Notes                                       |
|---------------------|-------------------|---------------------------------------------|
| Python              | `>=3.12,<4.0`     | Matches extras 1.1.0                         |
| Django              | `>=4.0,<7.0`      | CI: 4.2 (LTS), 5.2 (LTS), 6.0               |
| Channels            | `>=4.0,<5.0`      | **extra only**                              |
| channels-redis      | `>=4.2`           | **extra only**, prod multi-process          |
| graphene-django     | `>=3.2,<4.0`      | already an extras core dep                   |
| graphql-core        | `>=3.2,<3.3`      | transitive; `subscribe()` async path         |
| djangorestframework | `^3` (≥3.14)      | already an extras **core** dep (shared)      |
| django-filter       | `>=22.1`          | already an extras core dep                   |

**Removed for good:** `channels-api`, `rx`, `six`, `promise`.

---

## 4. Old → New Architecture Mapping

The Channels 1.x model maps ~1:1 onto Channels 4, which is what makes preserving the public
protocol feasible.

| Channels 1.x (current)                          | Channels 4 (new)                                                 |
|-------------------------------------------------|------------------------------------------------------------------|
| `message.reply_channel`                         | `consumer.channel_name`                                          |
| `Group(name).add(reply_channel)`                | `async_to_sync(channel_layer.group_add)(name, channel_name)`    |
| `Group(name).discard(reply_channel)`            | `async_to_sync(channel_layer.group_discard)(name, channel_name)` |
| `Group(name).send({"text": …})`                 | `async_to_sync(channel_layer.group_send)(name, event)`          |
| `WebsocketDemultiplexer`                         | `AsyncJsonWebsocketConsumer` subclass                            |
| `channels_api` `ResourceBinding` (signals→group)| in-house `SubscriptionBinding` (signals→`group_send`)           |
| `route_class` + `CHANNEL_LAYERS.ROUTING`        | `ProtocolTypeRouter`/`URLRouter` + `ASGI_APPLICATION`           |
| `rx.Observable.from_([conf])`                   | `async def subscribe_*` async generator yielding one `conf`      |
| `depromise_subscription` middleware             | `SubscriptionGraphQLView` HTTP executor                          |

**Two-channel flow (preserved):** (1) WS connect → server sends
`{"channel_id", "connect":"success"}`; (2) client POSTs a GraphQL `subscription{…}` over
HTTP echoing `channelId` → resolver joins/leaves groups, returns one-shot confirmation;
(3) model change → binding broadcasts serialized payload to the group → subscribers receive
it over WS. Requires a cross-process channel layer (Redis) when HTTP and WS run in separate
processes (§7.6).

---

## 5. Packaging Design (the core of this change)

### 5.1 Dependency isolation in extras (Poetry)

```toml
# graphene-django-extras/pyproject.toml
[tool.poetry.dependencies]
python              = ">=3.12,<4.0"
django              = ">=4.0,<7.0"
graphene-django     = "^3.2"
djangorestframework = "^3"
django-filter       = ">=22.1"
python-dateutil     = ">=2.8.2,<3.0"
channels            = {version = ">=4.0,<5.0", optional = true}
channels-redis      = {version = ">=4.2",     optional = true}

[tool.poetry.extras]
subscriptions = ["channels", "channels-redis"]
```

(Equivalent PEP 621 `[project.optional-dependencies]` is acceptable if the repo migrates to
that form; Poetry 2.x supports it. The chosen form must keep `channels` optional.)

### 5.2 Import isolation (base install must never import channels)

- All subscription code lives under `graphene_django_extras/subscriptions/`.
- `graphene_django_extras/__init__.py` **must not** import that subpackage (enforced by a
  test, §14 T-ISO).
- `graphene_django_extras/subscriptions/__init__.py` guards channels at import time:

```python
try:
    import channels  # noqa: F401
except ImportError as exc:  # pragma: no cover
    raise ImportError(
        "GraphQL subscriptions require the 'subscriptions' extra. Install with:\n"
        '    pip install "graphene-django-extras[subscriptions]"'
    ) from exc
```

So `import graphene_django_extras` is channels-free; only an explicit
`from graphene_django_extras.subscriptions import …` (or wiring the consumer) pulls channels,
with a friendly error if the extra is missing.

### 5.3 Canonical public import paths (new)

```python
from graphene_django_extras.subscriptions import (
    Subscription, GraphqlAPIDemultiplexer, SubscriptionGraphQLView,
)
```

### 5.4 Compatibility shim — `graphene-django-subscriptions` 0.1.0 (final)

The shim package is reduced to:

- `pyproject.toml` depending on `graphene-django-extras[subscriptions] >=1.2,<2`.
- A module tree mirroring the old import paths, each re-exporting from the new location and
  emitting `DeprecationWarning` on import:

```python
# graphene_django_subscriptions/subscription.py  (shim)
import warnings
from graphene_django_extras.subscriptions import Subscription  # noqa: F401
warnings.warn(
    "graphene_django_subscriptions is deprecated; import from "
    "graphene_django_extras.subscriptions instead.",
    DeprecationWarning, stacklevel=2,
)
```

Old code (`from graphene_django_subscriptions.subscription import Subscription`,
`...consumers import GraphqlAPIDemultiplexer`, `...depromise_subscription`) keeps working
for one deprecation cycle. README of the shim points to extras.

---

## 6. Public API Contract (developer-facing) — preserved

Behaviour is preserved; only the import root changes (and is bridged by the shim §5.4).

### 6.1 `Subscription`

Abstract `ObjectType`, subclassed via `Meta`:

```python
from graphene_django_extras.subscriptions import Subscription

class UserSubscription(Subscription):
    class Meta:
        serializer_class = UserSerializer   # required; DRF Serializer subclass
        stream = "users"                     # required; str
        queryset = None                      # optional; model must match serializer
        description = "User Subscription"    # optional
```

- Output fields (unchanged): `ok`, `error`, `stream`, `operation`, `action`.
- Generated arguments (unchanged names/semantics): `channelId` (req), `action` (req),
  `operation` (req), `id` (opt), `data` (opt, `[<Model>FieldsEnum]`).
- Enums (unchanged values): `ActionSubscriptionEnum {CREATE, UPDATE, DELETE, ALL_ACTIONS}`,
  `OperationSubscriptionEnum {SUBSCRIBE, UNSUBSCRIBE}`, `<Model>Fields` (same UPPER_SNAKE
  derivation as `subscription.py:78-82`).
- Classmethods preserved: `Field`, `model_label`, `_group_name`, `get_binding`.

### 6.2 `GraphqlAPIDemultiplexer`

Base WS consumer users subclass; new base is `AsyncJsonWebsocketConsumer`:

```python
class CustomAppDemultiplexer(GraphqlAPIDemultiplexer):
    subscriptions = {"users": UserSubscription, "groups": GroupSubscription}
    # `consumers = {stream: Sub.get_binding().consumer}` accepted as deprecated alias (§10)
```

### 6.3 `get_binding()` / `SubscriptionGraphQLView`

`get_binding()` returns a `SubscriptionBinding` (wires the model signals, idempotent);
legacy `.consumer` attribute preserved as a deprecated alias. `SubscriptionGraphQLView`
replaces the `depromise_subscription` middleware (§7.3).

---

## 7. Component Design

(Engine design is identical regardless of host package.)

### 7.1 `Subscription` type
Keep `__init_subclass_with_meta__` validation and enum/argument generation verbatim; drop
`six.string_types`→`str`. The requested-field set is **not** stored on the shared
`serializer_class.Meta` (that is the §11.1 race) — it is carried per-connection (§7.5).

### 7.2 `SubscriptionBinding` (replaces channels-api)
Per `(model, stream, serializer_class)`:
- Connect `post_save`/`post_delete` receivers, deduplicated via stable `dispatch_uid`.
- `post_save`: `action = "create" if created else "update"`; `post_delete`: `"delete"`.
- On signal: serialize the instance **once**; build payload
  `{"action", "model": model_label, "data": <full>}`; `group_send` to `"<label>-<action>"`
  **and** `"<label>-<action>-<pk>"` with event
  `{"type":"subscription.notify","stream":stream,"payload":payload}`.
- O(1) sends per event; field projection happens at the consumer (§7.5), so one
  serialization regardless of subscriber count (trade: a few extra bytes over the layer for
  correct per-connection projection).

### 7.3 `SubscriptionGraphQLView`
graphene-django's `GraphQLView` doesn't execute subscriptions. This subclass, when
`operation == "subscription"`, calls graphql-core `subscribe(...)`, drives the async
iterator for **exactly one** value via `async_to_sync` (`anext` then `aclose`), and returns
that `ExecutionResult`. Side effects (group join/leave) run inside the `subscribe_*`
generator before the single `yield`.

### 7.4 `subscribe_*` async generator
Reads `action/operation/channel_id/id/data`; resolves channel name from `channel_id`;
`ALL_ACTIONS` iterates `(create,update,delete)`; `SUBSCRIBE`→`group_add` + register control
message (fields), `UNSUBSCRIBE`→`group_discard` + deregister; `yield` one confirmation
`cls(ok, error, stream, operation, action)` then return. On error, yield `ok=False,
error=str(e)`. Group names built via `_group_name`; over-long/invalid labels hashed to stay
within the Channels group-name limit.

### 7.5 Per-connection field selection (correctness)
- On `SUBSCRIBE`: resolver `channel_layer.send(channel_name,
  {"type":"subscription.register","group":g,"fields":[...]})`.
- Consumer keeps `self._fields: dict[group, list[str]|None]`; `subscription_notify` filters
  `payload["data"]` to the registered fields before `send_json`. `None`/empty ⇒ full data.
- `UNSUBSCRIBE` sends `subscription.deregister`. Cross-process safe because
  `channel_layer.send(channel_name, …)` routes to the specific consumer.

### 7.6 Consumer & routing/settings
`AsyncJsonWebsocketConsumer`: `connect`→accept + handshake frame + ensure bindings
registered; `subscription_notify`/`register`/`deregister` handlers; best-effort
`group_discard` on `disconnect`. User wiring migrates from `CHANNEL_LAYERS.ROUTING`/
`route_class` to `ProtocolTypeRouter`/`URLRouter` + `ASGI_APPLICATION`; prod uses a Redis
channel layer. Documented in §9.

---

## 8. File-level Plan (informational)

**extras repo (`graphene_django_extras/subscriptions/`):**

| File              | Content                                                            |
|-------------------|-------------------------------------------------------------------|
| `__init__.py`     | channels import-guard (§5.2); public exports                      |
| `subscription.py` | graphene-3 `Subscription` type; async `subscribe_*`               |
| `consumers.py`    | `GraphqlAPIDemultiplexer` (`AsyncJsonWebsocketConsumer`)          |
| `bindings.py`     | `SubscriptionBinding` (signals)                                   |
| `mixins.py`       | serialize/deserialize + field-projection helpers                  |
| `views.py`        | `SubscriptionGraphQLView`                                         |
| `compat.py`       | `depromise_subscription` deprecated shim                           |
| `pyproject.toml`  | add optional deps + `[tool.poetry.extras] subscriptions`          |
| `tests/subscriptions/` | full suite (§14)                                             |
| docs              | subscriptions guide + migration                                   |

**shim repo (`graphene-django-subscriptions`):** strip to re-export modules + `pyproject.toml`
depending on `graphene-django-extras[subscriptions]`; bump to `0.1.0`; keep `docs/SPEC.md`.

---

## 9. Migration Guide (end users) — outline

1. `pip install "graphene-django-extras[subscriptions]"` (or keep
   `graphene-django-subscriptions`, now a shim that pulls it).
2. Update imports to `graphene_django_extras.subscriptions` (old paths still work, warn).
3. Remove `channels_api` from `INSTALLED_APPS`.
4. Replace `routing.py` + `CHANNEL_LAYERS.ROUTING` with `asgi.py` + `ASGI_APPLICATION`.
5. Replace the `GRAPHENE.MIDDLEWARE` `depromise_subscription` entry with the URL served by
   `SubscriptionGraphQLView`.
6. Rename `consumers={….consumer}` → `subscriptions={stream: Sub}` (old form warns/works).
7. Configure a Redis channel layer for multi-process deployments.

---

## 10. Backward-Compatibility & Deprecations

- **Preserved:** `Subscription` (Meta keys, enums, args, outputs, `Field`, `model_label`,
  `_group_name`, `get_binding`), `GraphqlAPIDemultiplexer`, the wire protocol (§4), and old
  import paths via the shim.
- **Deprecated (work + `DeprecationWarning`):** `graphene_django_subscriptions.*` imports;
  `consumers={stream: Sub.get_binding().consumer}` form; `depromise_subscription`.
- **Breaking (documented):** Channels-4 routing/settings change; `info.context.reply_channel`
  gone (resolver uses `channelId`); Python 2 / graphene 2 / Channels < 4 dropped.

---

## 11. Correctness / Security Fixes (no public-contract change)

- **11.1 `only_fields` global mutation race** — today `setattr(serializer_class.Meta,
  "only_fields", data)` is shared mutable state (last-writer-wins across connections). Fixed
  by per-connection field selection (§7.5).
- **11.2** Replace broad `except Exception` swallowing with logging; never catch
  `BaseException`.
- **11.3** Enforce Channels group-name charset/length; hash overflowing labels.
- **11.4** Idempotent signal registration via `dispatch_uid`.

---

## 12. Acceptance Criteria

- **AC1** With only `graphene-django-extras` installed (no channels), `import
  graphene_django_extras` succeeds and imports **no** `channels`; `import
  graphene_django_extras.subscriptions` raises the friendly `[subscriptions]` ImportError.
  [T-ISO]
- **AC2** With the extra installed, `Subscription` subclasses build a valid schema on
  Python 3.12+, Django ≥4.0, graphene-django ≥3.2; no `rx`/`six`/`promise`/`channels_api`
  imports anywhere. [T-IMPORT, T-UNIT]
- **AC3** WS connect yields `{"channel_id": <str>, "connect": "success"}`. [T-CONSUMER]
- **AC4** `subscription{…SUBSCRIBE…}` over the HTTP view returns
  `{ok:true,error:null,stream:<stream>}` and adds the channel to the correct group(s).
  [T-RESOLVER, T-E2E]
- **AC5** After `SUBSCRIBE UPDATE id:5`, saving instance 5 delivers a WS frame per §… with
  `action:"update"`, `model:"<label>"`, `data` filtered to requested fields. [T-E2E]
- **AC6** `CREATE`/`DELETE`/`ALL_ACTIONS` deliver on the matching events; others don't.
  [T-E2E]
- **AC7** `UNSUBSCRIBE` removes membership; later events deliver nothing. [T-E2E]
- **AC8** Omitting `data` ⇒ full payload; two connections with different `data` on the same
  group each get their own projection (proves §11.1 fixed). [T-CONCURRENCY]
- **AC9** Generated enums match legacy values (snapshot). [T-UNIT]
- **AC10** Shim: `graphene_django_subscriptions.*` old imports work and emit
  `DeprecationWarning`; deprecated `consumers={…}` form still wires. [T-COMPAT]
- **AC11** CI matrix green, incl. a base-install (no-extra) job that asserts channels is
  absent. [CI]

---

## 13. Packaging & CI

- **Packaging:** extras `pyproject.toml` gains optional `channels`/`channels-redis` + the
  `subscriptions` extra (§5.1). Shim repo migrates to `pyproject.toml` depending on
  `graphene-django-extras[subscriptions]`.
- **CI (GitHub Actions, both repos):** matrix Python {3.12, 3.13} × Django {4.2, 5.2, 6.0};
  jobs: (a) **base install** — assert `channels` not importable and base import works;
  (b) **`[subscriptions]` install** — full subscription test suite; lint (`ruff`),
  format check, coverage ≥ 90% on subscription modules.

---

## 14. Test Plan

Stack: `pytest`, `pytest-django`, `pytest-asyncio`, Channels `WebsocketCommunicator`,
`InMemoryChannelLayer`, a tiny test app (model + DRF serializer).

| ID            | Scope        | Asserts                                                          |
|---------------|--------------|-----------------------------------------------------------------|
| T-ISO         | packaging    | base import channels-free; guarded ImportError without extra.   |
| T-IMPORT      | static       | no `rx`/`six`/`promise`/`channels_api`; `__all__`.              |
| T-UNIT        | unit         | `_group_name`, `model_label`, enum generation, field filter.    |
| T-CONSUMER    | channels     | connect handshake; notify/register/deregister handlers.         |
| T-RESOLVER    | async        | `subscribe_*` group add/discard + control msg; single yield.    |
| T-VIEW        | http         | one-shot confirmation from `SubscriptionGraphQLView`.           |
| T-E2E         | integration  | open WS → subscribe → save/delete → assert WS frame.           |
| T-CONCURRENCY | integration  | two connections, different `data`, correct per-connection output.|
| T-COMPAT      | regression   | shim imports + deprecated forms warn & wire.                    |
| T-BINDING     | unit         | signal dedup; single serialize per event.                       |

Each AC (§12) maps to ≥ 1 test. Coverage gate ≥ 90% on subscription modules.

---

## 15. Risks & Open Questions

- **R1** HTTP-resolved subscribe needs a shared channel layer across HTTP+WS processes
  (Redis in prod). Documented; dev default InMemory.
- **R2** `SubscriptionGraphQLView` should target graphql-core's documented `subscribe()`,
  not private graphene-django internals; pin tested versions in CI.
- **R3** Field projection ships full data over the layer; fine for typical models, revisit
  with a producer-side cache if profiling shows pressure.
- **R4** Release coupling: a subscriptions fix now ships in an extras release. Accepted
  (atomic compatibility for a single maintainer).
- **OQ1** `channel_id` value: use `self.channel_name` directly (proposed) vs. an opaque
  token mapped to it.
- **OQ2** Django floor in CI: declare `>=4.0` but CI-test `4.2+` (4.0 is upstream-EOL)?
  Proposed yes.
- **OQ3** Session scope: the `graphene-django-extras` repo must be added to this session to
  implement §8; only the shim repo is currently in scope.

---

## 16. Definition of Done

1. SPEC approved.
2. extras `1.2.0`: `subscriptions/` package + `[subscriptions]` extra; all §12 ACs green via
   §14 tests; base install proven channels-free.
3. shim `graphene-django-subscriptions` `0.1.0`: re-exports + deprecation warnings; old
   imports green.
4. CI matrices green in both repos (incl. the base-install no-extra job).
5. READMEs + migration guide rewritten; no forbidden legacy imports remain.
6. Changes committed/pushed to the designated branches.
