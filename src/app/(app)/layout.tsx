import Link from "next/link";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <nav className="top">
        <strong>Lettings Atlas</strong>
        <Link href="/map">Map</Link>
        <Link href="/branches">Branches</Link>
        <Link href="/review">Review</Link>
        <span className="spacer" />
        <form action="/auth/signout" method="post">
          <button type="submit">Sign out</button>
        </form>
      </nav>
      {children}
    </>
  );
}
