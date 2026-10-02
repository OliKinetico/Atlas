import Link from "next/link";

export default function Home() {
  return (
    <main>
      <h1>Surrey lettings agents</h1>
      <ul>
        <li>
          <Link href="/map">Map</Link>: every branch, coloured by ownership
        </li>
        <li>
          <Link href="/branches">Branches</Link>: sortable table with CSV export
        </li>
        <li>
          <Link href="/review">Review</Link>: proposed matches awaiting a decision
        </li>
      </ul>
    </main>
  );
}
