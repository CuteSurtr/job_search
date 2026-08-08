import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3001";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;

  return {
    metadataBase: new URL(origin),
    title: "NurseLaunch — New Grad Nursing Jobs",
    description:
      "Fresh new graduate RN residencies and entry-level nursing roles, checked hourly.",
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: {
      title: "NurseLaunch — New Grad Nursing Jobs",
      description: "New grad nursing jobs, before the rush. Fresh roles checked hourly.",
      type: "website",
      images: [{ url: new URL("/og.png", origin), width: 1200, height: 630, alt: "NurseLaunch new grad nursing job tracker" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "NurseLaunch — New Grad Nursing Jobs",
      description: "New grad nursing jobs, before the rush. Fresh roles checked hourly.",
      images: [new URL("/og.png", origin)],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        {children}
      </body>
    </html>
  );
}
