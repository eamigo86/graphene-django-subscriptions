# Graphene-Django-Subscriptions

> [!WARNING]
> ## ⚠️ This project is deprecated and no longer maintained
>
> GraphQL subscriptions have been **rewritten and merged into**
> **[django-graphex](https://github.com/eamigo86/django-graphex)**, where they ship
> as the optional `[subscriptions]` extra (rebuilt on **Django Channels 4**).
>
> | | |
> |---|---|
> | **New repository** | https://github.com/eamigo86/django-graphex |
> | **New PyPI package** | https://pypi.org/project/django-graphex/ |
> | **Subscriptions guide** | [docs/usage/subscriptions.md](https://github.com/eamigo86/django-graphex/blob/main/docs/usage/subscriptions.md) |
> | **Migration guide** | [docs/migration.md](https://github.com/eamigo86/django-graphex/blob/main/docs/migration.md) |
>
> Please migrate:
>
> ```bash
> uv add "django-graphex[subscriptions]"     # or: pip install "django-graphex[subscriptions]"
> ```
>
> This repository is kept **read-only, for historical reference**. No further
> releases, fixes or support will be provided here.

---

`graphene-django-subscriptions` added WebSocket/Channels subscription support on
top of `graphene-django` and the old `channels-api`. Its successor lives in
**django-graphex**: the same two-channel protocol, reimplemented on Channels 4,
with id-only or full-payload notifications, per-subscriber filtering and
server-side scoping — installed via the `[subscriptions]` extra so the base
package never depends on `channels`.

## License

MIT — see [LICENSE](LICENSE).
