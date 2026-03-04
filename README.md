# Trellix (Collaborative Kanban)

A Trello-like collaborative board with real-time sync, expandable card folders, and SQLite persistence.

## Implemented from your requirements

- Todo items now support checked/unchecked state and can link to another card reference.
- Attachments support both URL links and actual file uploads (saved locally in `/uploads`).
- Notes are plain text.
- RAG status is per card only.
- Contacts now require **Name** and **Number**, with optional role/company/email/birthday/rating/notes.
- Card modules are plugin-style via board-level toggles (todo, notes, media, gating, RAG, contacts).
- Persistence is now backed by SQLite (`trellix.db`) instead of in-memory-only state.
- Gating completion behavior: marking a card complete prompts whether gating cards are complete; accepting marks gating cards complete.

## Permission-aware cross-board references

- The backend supports permission-aware card discovery via `GET /api/cards`.
- Board owners can share board access via `POST /api/boards/share`.
- Cross-board reference selectors only show cards from boards the current user can read.

## Run locally

```bash
npm start
```

Open `http://localhost:4173`.

## Notes

- Uploaded files are stored locally in `uploads/`.
- SQLite database file is `trellix.db`.
