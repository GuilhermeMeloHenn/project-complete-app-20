import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

const TITLE = "Naveiro — Gestão de Barbearia";
const DESC =
  "Sistema completo de barbearia: agendamentos, equipe, comissões, metas e financeiro em um só lugar.";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESC },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESC },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap",
      },
      { rel: "stylesheet", href: "/naveiro/app.css" },
    ],
  }),
  component: Index,
});

function Index() {
  useEffect(() => {
    if (document.getElementById("naveiro-app-script")) return;
    const s = document.createElement("script");
    s.id = "naveiro-app-script";
    s.src = "/naveiro/app.js";
    document.body.appendChild(s);
  }, []);

  return <div id="root" suppressHydrationWarning />;
}
