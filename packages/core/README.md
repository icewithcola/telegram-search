# @tg-search/core

Telegram Search domain services, persistence models, and application handlers.

`createTelegramApplicationRuntime()` composes direct business services. `registerApplicationHandlers()` exposes validated unary and streaming Eventa contracts without making the internal database and Telegram orchestration event-driven.

Remote message reads do not persist. Structured forward, media, and link metadata is stored only through explicit synchronization paths.

## Sync whitelist

Account settings include `syncWhitelist` with `enabled`, `chatTypes`, `chatIds`, and
`cleanExcluded`. It is disabled by default. When enabled, categories and explicit
chat IDs are combined with OR; an empty selection accepts no messages. Filtering
applies before message storage and media/embedding resolvers, including realtime,
catch-up, and Takeout history. Unknown chat types require an explicit chat ID.

Enable **Clean synced messages outside the whitelist** in Settings to hard-delete
excluded local messages whenever settings are saved. This removes their embedded
vectors and unreferenced database photo records in a transaction. Telegram data
is unchanged. Shared chats accessible to other accounts and external media files
are preserved. Deleted database space is reusable; database files need not shrink.
Cleanup and message processing are ordered to prevent in-flight resolvers from
restoring deleted messages. No schema migration is required.

## Storage usage

Settings shows the combined physical size of public application tables and their
indexes across all accounts. The Sync page shows estimated message and photo row
sizes for the focused chat, scoped to the current account's accessible messages.
Message rows include embeddings. Chat estimates exclude shared indexes and free
space, so they do not add up to the overall database size. Separately stored media
files and browser caches are excluded from both views. Refresh either view to
update its snapshot. Inspection is read-only and requires no schema migration.
