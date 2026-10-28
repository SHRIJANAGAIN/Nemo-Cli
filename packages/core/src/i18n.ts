/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/** Minimal i18n: en + hi strings for CLI messages. */

const STRINGS: Record<string, Record<string, string>> = {
  en: {
    logged_in: "Logged in with API key.",
    logged_out: "Logged out.",
    not_logged_in: "Not logged in.",
    session_not_found: "session not found",
  },
  hi: {
    logged_in: "API key se login ho gaya.",
    logged_out: "Logout ho gaya.",
    not_logged_in: "Login nahi hai.",
    session_not_found: "session nahi mila",
  },
}

export function t(key: string, locale: string = process.env.NEMO_LOCALE ?? "en"): string {
  return STRINGS[locale]?.[key] ?? STRINGS.en[key] ?? key
}
