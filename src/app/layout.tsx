import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lettings Atlas",
  description: "Surrey lettings agent map (private)",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB">
      <body>{children}</body>
    </html>
  );
}
