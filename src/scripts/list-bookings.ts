#!/usr/bin/env node
/** Reminder: LibCal cancellations are email-only at UNC. */
console.log(
  JSON.stringify(
    {
      cancellation:
        "Use the cancel link in your LibCal confirmation email from alerts@mail.libcal.com. " +
        "This project does not support programmatic cancellation — LibCal does not expose cancel tokens outside email.",
    },
    null,
    2,
  ),
);
