import MissionShell from "./mission-shell";

export default async function MissionDetailPage({
  params,
}: {
  params: Promise<{ missionId: string }>;
}) {
  const { missionId } = await params;
  return <MissionShell missionId={missionId} />;
}
