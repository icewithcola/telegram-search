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
indexes across all accounts. On the Sync page, click Calculate for the focused
chat to scan accessible messages in bounded batches. Progress is streamed over
the existing event bridge, and leaving the page cancels the scan. Chat estimates
include message embeddings, photo and sticker records, inline bytes, and the
sizes of externally stored media files. File sizes are read from metadata without
loading the files. Completed chat results are cached per browser session and chat;
Refresh recalculates them. Missing media is reported. Chat estimates exclude
shared indexes and free space and need not add up to the database total. This
read-only inspection requires no schema migration.
