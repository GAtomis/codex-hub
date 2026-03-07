import ProjectConsole from "./project-console";

export default async function ProjectPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <ProjectConsole slug={slug} />;
}
