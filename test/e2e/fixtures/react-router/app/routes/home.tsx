import type { Route } from "./+types/home";
import { Welcome } from "../welcome/welcome";

// oxlint-disable-next-line no-empty-pattern -- scaffolded boilerplate from create-react-router
export function meta({}: Route.MetaArgs) {
  return [
    { title: "New React Router App" },
    { name: "description", content: "Welcome to React Router!" },
  ];
}

export default function Home() {
  return <Welcome />;
}
