---
"clerk": patch
---

`clerk deploy` now lists the DMARC TXT record that new production domains require, prints each record's real type, and includes the record in the exported zone file. Previously it only listed CNAME records, so a domain without an existing DMARC policy could never finish DNS verification from the CLI.
