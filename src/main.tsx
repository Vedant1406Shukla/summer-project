import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { ClerkProvider } from "@clerk/react";

createRoot(document.getElementById("root")!).render(
  <ClerkProvider afterSignOutUrl="/">
    <App />
  </ClerkProvider>
);
