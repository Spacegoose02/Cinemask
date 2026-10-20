# Unraid

## Install from the template

Docker tab → **Add Container** → **Template** field: paste

```
https://raw.githubusercontent.com/Spacegoose02/cinemask/main/unraid/cinemask.xml
```

The defaults assume the common `/mnt/user/data` layout (downloads and media on one share, so imports hardlink). See [install.md](install.md) for the folder layout and first-run steps.

## Getting into Community Applications

Community Applications lists templates from repositories the CA maintainers have accepted. To list Cinemask:

1. Keep `unraid/cinemask.xml` in this repository's default branch (it is). The template's `TemplateURL`, `Icon` and `Support` already point here.
2. Create a support thread on the Unraid forums (Docker Containers section) describing the app, and set the template's `<Support>` to that thread's URL instead of GitHub issues if you prefer.
3. Submit the repository through the Community Applications submission form linked from the CA support thread on the Unraid forums. The maintainers review the template and add the repository.
4. After that, template changes reach users automatically when CA refreshes.

## Updating

Updates appear as "update ready" on the Docker tab when a new `latest` image is published. Cinemask backs up its database before applying any changes, so you can restore from **Settings → Backups** if an update misbehaves.
