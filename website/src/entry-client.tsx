import { hydrateRoot } from "react-dom/client";
import App from "./App";

hydrateRoot(document.getElementById("app")!, <App initialPath={window.location.pathname} />);
