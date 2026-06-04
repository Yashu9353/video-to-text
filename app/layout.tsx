import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Video to Text — Free Transcriber',
  description: 'Upload any English video and get a full text transcript. Free, powered by Groq Whisper.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0 }}>{children}</body>
    </html>
  );
}
