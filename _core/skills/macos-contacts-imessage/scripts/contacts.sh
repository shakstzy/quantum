#!/usr/bin/env bash
# contacts.sh -- osascript wrapper for Contacts.app
# Usage:
#   contacts.sh find   [--phone <E.164>] [--name <q>] [--email <e>] [--json]
#   contacts.sh create --first <f> [--last <l>] [--phone <p>] [--email <e>] [--org <o>] [--note <n>]
#   contacts.sh update --id <id> [--first <f>] [--last <l>] [--phone <p>] [--email <e>] [--note <n>]
#   contacts.sh delete --id <id>
#
# Returns TSV by default, JSON with --json.
# TSV columns: id<TAB>first<TAB>last<TAB>phones (comma-joined)<TAB>emails (comma-joined)

set -euo pipefail

die() { echo "contacts.sh: $*" >&2; exit 2; }

cmd="${1:-}"; shift || true
[[ -z "$cmd" ]] && die "missing subcommand (find|create|update|delete)"

# Arg parsing
PHONE=""; NAME=""; EMAIL=""; FIRST=""; LAST=""; ORG=""; NOTE=""; ID=""; JSON=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --phone) PHONE="$2"; shift 2 ;;
    --name)  NAME="$2";  shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --first) FIRST="$2"; shift 2 ;;
    --last)  LAST="$2";  shift 2 ;;
    --org)   ORG="$2";   shift 2 ;;
    --note)  NOTE="$2";  shift 2 ;;
    --id)    ID="$2";    shift 2 ;;
    --json)  JSON=1; shift ;;
    *) die "unknown flag: $1" ;;
  esac
done

# AppleScript helper: emit one matched person per line as TSV.
#   id<TAB>first<TAB>last<TAB>phone1,phone2<TAB>email1,email2
AS_EMIT_PERSONS=$(cat <<'APPLESCRIPT_END'
on joinList(lst, sep)
  set AppleScript's text item delimiters to sep
  set s to lst as text
  set AppleScript's text item delimiters to ""
  return s
end joinList
on cleanTSV(x)
  set out to ""
  repeat with c in (characters of (x as text))
    set cc to c as text
    if cc is tab or cc is linefeed or cc is return then
      set out to out & " "
    else
      set out to out & cc
    end if
  end repeat
  return out
end cleanTSV
on emitPerson(p)
  tell application "Contacts"
    set pid to id of p
    set pf to ""
    try
      set pf to first name of p
    end try
    set pl to ""
    try
      set pl to last name of p
    end try
    set phoneVals to {}
    try
      repeat with ph in phones of p
        set end of phoneVals to (value of ph as text)
      end repeat
    end try
    set emailVals to {}
    try
      repeat with em in emails of p
        set end of emailVals to (value of em as text)
      end repeat
    end try
    set phoneStr to my joinList(phoneVals, ",")
    set emailStr to my joinList(emailVals, ",")
    return my cleanTSV(pid) & tab & my cleanTSV(pf) & tab & my cleanTSV(pl) & tab & my cleanTSV(phoneStr) & tab & my cleanTSV(emailStr)
  end tell
end emitPerson
APPLESCRIPT_END
)

tsv_to_json() {
  /usr/bin/python3 -c "$(cat <<'PY'
import sys, json
rows = []
for line in sys.stdin:
    line = line.rstrip("\n")
    if not line:
        continue
    parts = line.split("\t")
    while len(parts) < 5:
        parts.append("")
    pid, first, last, phones, emails = parts[:5]
    rows.append({
        "id": pid,
        "firstName": first,
        "lastName": last,
        "phones": [p for p in phones.split(",") if p],
        "emails": [e for e in emails.split(",") if e],
    })
print(json.dumps(rows, ensure_ascii=False))
PY
)"
}

case "$cmd" in
  find)
    [[ -z "$PHONE$NAME$EMAIL" ]] && die "find requires one of --phone, --name, --email"
    # JXA + CNContactStore: indexed native search. Sub-second on 2k+ contacts.
    # AppleScript iteration over `every person` is ~800x slower and unusable in production.
    out=$(/usr/bin/osascript -l JavaScript <<JXA
ObjC.import('Contacts');
ObjC.import('Foundation');
const store = \$.CNContactStore.alloc.init;
const PHONE = "$PHONE", NAME = "$NAME", EMAIL = "$EMAIL";
let predicate;
if (PHONE) {
  const pn = \$.CNPhoneNumber.phoneNumberWithStringValue(PHONE);
  predicate = \$.CNContact.predicateForContactsMatchingPhoneNumber(pn);
} else if (EMAIL) {
  predicate = \$.CNContact.predicateForContactsMatchingEmailAddress(EMAIL);
} else {
  predicate = \$.CNContact.predicateForContactsMatchingName(NAME);
}
const keys = \$(['givenName','familyName','phoneNumbers','emailAddresses','identifier']);
const contacts = store.unifiedContactsMatchingPredicateKeysToFetchError(predicate, keys, null);
if (!contacts) { throw new Error('lookup failed (permission denied?)'); }
const clean = (s) => (s || '').replace(/[\t\n\r]/g, ' ');
const lines = [];
const n = contacts.count;
for (let i = 0; i < n; i++) {
  const c = contacts.objectAtIndex(i);
  const phones = [];
  for (let j = 0; j < c.phoneNumbers.count; j++) {
    phones.push(c.phoneNumbers.objectAtIndex(j).value.stringValue.js);
  }
  const emails = [];
  for (let j = 0; j < c.emailAddresses.count; j++) {
    emails.push(c.emailAddresses.objectAtIndex(j).value.js);
  }
  lines.push([
    clean(c.identifier.js),
    clean(c.givenName.js),
    clean(c.familyName.js),
    phones.join(','),
    emails.join(','),
  ].join('\t'));
}
lines.join('\n');
JXA
)
    if [[ $JSON -eq 1 ]]; then
      printf '%s\n' "$out" | tsv_to_json
    else
      printf '%s\n' "$out"
    fi
    ;;

  create)
    [[ -z "$FIRST$LAST" ]] && die "create requires --first or --last"
    [[ -z "$PHONE$EMAIL" ]] && die "create requires --phone or --email"
    out=$(osascript <<OSA
$AS_EMIT_PERSONS
tell application "Contacts"
  set np to make new person with properties {first name:"$FIRST", last name:"$LAST", organization:"$ORG", note:"$NOTE"}
  if "$PHONE" is not "" then
    make new phone at end of phones of np with properties {label:"mobile", value:"$PHONE"}
  end if
  if "$EMAIL" is not "" then
    make new email at end of emails of np with properties {label:"home", value:"$EMAIL"}
  end if
  save
  return my emitPerson(np)
end tell
OSA
)
    if [[ $JSON -eq 1 ]]; then
      printf '%s\n' "$out" | tsv_to_json
    else
      printf '%s\n' "$out"
    fi
    ;;

  update)
    [[ -z "$ID" ]] && die "update requires --id"
    out=$(osascript <<OSA
$AS_EMIT_PERSONS
tell application "Contacts"
  set p to person id "$ID"
  if "$FIRST" is not "" then set first name of p to "$FIRST"
  if "$LAST"  is not "" then set last name of p to "$LAST"
  if "$NOTE"  is not "" then set note of p to "$NOTE"
  if "$PHONE" is not "" then
    make new phone at end of phones of p with properties {label:"mobile", value:"$PHONE"}
  end if
  if "$EMAIL" is not "" then
    make new email at end of emails of p with properties {label:"home", value:"$EMAIL"}
  end if
  save
  return my emitPerson(p)
end tell
OSA
)
    if [[ $JSON -eq 1 ]]; then
      printf '%s\n' "$out" | tsv_to_json
    else
      printf '%s\n' "$out"
    fi
    ;;

  delete)
    [[ -z "$ID" ]] && die "delete requires --id"
    osascript <<OSA >/dev/null
tell application "Contacts"
  delete person id "$ID"
  save
end tell
OSA
    echo "deleted $ID"
    ;;

  *) die "unknown subcommand: $cmd" ;;
esac
