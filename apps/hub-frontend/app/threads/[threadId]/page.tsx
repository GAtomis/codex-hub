import ThreadLive from "./thread-live";

export default async function ThreadPage({ params }: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await params;
  return <ThreadLive threadId={threadId} />;
}
