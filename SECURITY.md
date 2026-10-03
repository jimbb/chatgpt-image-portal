# Security

This is a private administration service handling account tokens, provider keys,
proxy credentials, prompts, backups, and generated images.

- Use a unique random administrator key. The example leaves it empty so setup is required.
- The default compose binds to localhost. Remote access needs TLS, authentication, and restricted admin access.
- Keep runtime files, exports, databases, logs, and backups out of Git and public storage.
- Admin exports contain credential-bearing account records. UI masking does not prove encryption at rest.
- Rotate credentials that may have been exposed.

Use GitHub private vulnerability reporting when available. Do not put tokens,
account exports, private URLs, or personal images in public issues.
