"use client";

import { useActionState } from "react";
import { requestMagicLink, type LoginState } from "./actions";

const initial: LoginState = { status: "idle" };

export function LoginForm() {
  const [state, action, pending] = useActionState(requestMagicLink, initial);
  return (
    <form action={action} className="stack">
      <label htmlFor="email">Email</label>
      <input id="email" name="email" type="email" autoComplete="email" required />
      <button type="submit" disabled={pending}>
        {pending ? "Sending…" : "Send sign-in link"}
      </button>
      {state.message && (
        <p className={state.status === "error" ? "error" : "muted"}>{state.message}</p>
      )}
    </form>
  );
}
