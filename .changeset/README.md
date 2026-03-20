# Changesets

This directory is used by [Changesets](https://github.com/changesets/changesets) to manage versioning and changelogs.

To add a changeset, run:

```sh
bunx changeset
```

This will prompt you to select the packages that changed and the type of change (patch, minor, major). A markdown file will be created in this directory describing the change — commit it with your PR.
