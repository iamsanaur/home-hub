# Importing UPI and bank statements

Finance → **To review** → **Import a statement** reads a PhonePe, Google Pay, Paytm or bank statement PDF and files its
payments in the same To review inbox as automatic captures. Nothing is booked until someone confirms it there.

## What stays on the phone
The PDF is opened and its text extracted **on the device** (Android: PDFBox; iOS: PDFKit). Neither the file nor its text
is uploaded. Password-protected statements are unlocked on the phone; the password is never stored or sent. Only the
payment rows the person ticks go to HomeHub: date, amount, direction, merchant, the UPI reference and the last four
digits of the account. The UPI reference is stored only as a hash (in the record id) plus its last four digits.

## Deduplication (`backend/firebase/functions/src/finance/statementImport.ts`)
1. **Same UPI reference** (UTR/RRN) as anything already captured → left out. This is the same record id automatic
   capture uses, so a payment seen first in a bank SMS and later in a statement is one record, whatever its status.
   A payment the person dismissed is not brought back.
2. **Listed twice in one file** → kept once.
3. **No reference match, but same amount and direction at about the same time** as something in To review or entered by
   hand (within 30 minutes, or the same day when the statement has no time) → shown as "Possibly already recorded" and
   left unticked. It is flagged, never silently dropped.

The phone previews (`dryRun`) before anything is written, and sends at most 150 rows per request (the gateway limit is
64 KB). Importing the same file twice adds nothing the second time.

## Reading the text (`StatementParser.kt` / `StatementParser.swift`)
Every line that starts with a date opens an entry; the lines after it belong to it. Amount, direction, merchant, UPI
reference and time are taken from the entry. Failed payments and entries without an amount are ignored. If the
direction (money in or out) cannot be established the entry is skipped and counted — never guessed. Bank statements
lose their debit/credit columns in plain text, so direction comes from the running balance (or a `UPI/DR/` marker).

Both platforms are tested against the same `shared/statement-fixtures/fixtures.json`. **The fixtures are modelled on each
app's export, not copied from real statements.** If a real statement is misread, add its (redacted) lines as a new case
and fix the parser; Android and iOS then stay in step.
