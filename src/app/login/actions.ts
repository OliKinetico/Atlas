"use server";

import { headers } from "next/headers";
import { isAllowedEmail } from "@/lib/allowlist";
import { createAdminClient, createClient } from "@/lib/supabase/server";

export type LoginState = { status: "idle" | "sent" | "error"; message?: string };

const GENERIC_SENT =
  "If that address is permitted, a sign-in link is on its way. Check your inbox.";

export async function requestMagicLink(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return { status: "error", message: "Enter a valid email address." };
  }

  // Not on the allowlist: send nothing, and do not reveal whether the address is known.
  if (!isAllowedEmail(email)) return { status: "sent", message: GENERIC_SENT };

  // Public sign-ups can be disabled in Supabase: allowlisted users are created here
  // with the service role, and the magic link never creates users.
  const admin = createAdminClient();
  const { error: createError } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (createError && createError.code !== "email_exists") {
    return { status: "error", message: "Sign-in is unavailable. Try again shortly." };
  }

  const h = await headers();
  const origin =
    h.get("origin") ??
    `${h.get("x-forwarded-proto") ?? "https"}://${h.get("x-forwarded-host") ?? h.get("host")}`;

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false, emailRedirectTo: `${origin}/auth/callback` },
  });
  if (error) {
    return { status: "error", message: "Could not send the link. Try again shortly." };
  }
  return { status: "sent", message: GENERIC_SENT };
}
