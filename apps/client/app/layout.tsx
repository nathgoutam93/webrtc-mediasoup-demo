import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mediasoup Demo Client",
  description: "sfu based video conferencing and live session broadcast",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
