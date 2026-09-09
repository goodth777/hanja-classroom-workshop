import { StudentGame } from "@/components/student-game";

export default async function JoinPage({
  params,
}: {
  params: Promise<{ roomCode: string }>;
}) {
  const { roomCode } = await params;
  return <StudentGame roomCode={roomCode} />;
}
