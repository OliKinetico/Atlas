import { LoginForm } from "./login-form";

const ERRORS: Record<string, string> = {
  not_allowed: "That account is not permitted to use this app.",
  link_invalid: "That sign-in link is invalid or has expired. Request a new one.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <main className="narrow">
      <h1>Sign in</h1>
      {error && ERRORS[error] && <p className="error">{ERRORS[error]}</p>}
      <LoginForm />
    </main>
  );
}
