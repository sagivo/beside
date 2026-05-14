import { renderToString } from "react-dom/server";
import App from "./App";
import { DOC_PAGES } from "./docs/pages";

export function render(pathname = "/") {
  return renderToString(<App initialPath={pathname} />);
}

export function getDocRoutes(): string[] {
  return DOC_PAGES.map((p) => p.path);
}
