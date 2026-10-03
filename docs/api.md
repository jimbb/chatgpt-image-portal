# API reference

Protected routes accept `Authorization: Bearer <portal-key>`; management routes
require an administrator key or role.

- `GET /v1/models`
- `POST /v1/images/generations`
- `POST /v1/images/edits`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages`
- `POST /v1/search`
- `GET` and `POST /api/image-tasks`
- `POST /api/image-tasks/{task_id}/resume-poll`
- `POST /api/grid/faces`

FastAPI's generated schema is available at `/docs`. Compatibility routes focus
on image, text, and search workflows.
