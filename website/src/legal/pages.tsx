import type { ReactNode } from "react";

export interface LegalSection {
  title: string;
  body: ReactNode;
}

export interface LegalPageData {
  slug: "privacy" | "terms";
  path: string;
  title: string;
  description: string;
  updated: string;
  sections: LegalSection[];
}

export const LEGAL_PAGES: LegalPageData[] = [
  {
    slug: "privacy",
    path: "/privacy",
    title: "Privacy Policy",
    description:
      "How Beside handles website visits, downloads, local app data, optional model providers, and support messages.",
    updated: "May 22, 2026",
    sections: [
      {
        title: "Overview",
        body: (
          <>
            <p>
              Beside is built as local-first software. The app is designed so your captures,
              transcripts, embeddings, wiki pages, and memory index live on your own device by
              default. We do not operate a Beside cloud account system, analytics pipeline, or
              hosted sync service for your app data.
            </p>
            <p>
              This policy explains what we collect through the website and support channels, what
              the app stores locally, and what may leave your machine only when you configure
              another service.
            </p>
          </>
        ),
      },
      {
        title: "Website data",
        body: (
          <>
            <p>
              When you visit the Beside website, standard hosting infrastructure may process basic
              request information such as IP address, browser type, requested URL, referring page,
              and timestamps for security, reliability, and abuse prevention.
            </p>
            <p>
              The website does not require an account and does not intentionally use product
              analytics cookies to track your use of Beside.
            </p>
          </>
        ),
      },
      {
        title: "Local app data",
        body: (
          <>
            <p>
              Beside stores app data on your computer, including screenshots or other captured
              signals you enable, OCR text, audio transcripts, summaries, embeddings, SQLite
              indexes, logs, and generated Markdown wiki files. Those files are controlled by you
              and are not uploaded to Beside.
            </p>
            <p>
              The technical details and configuration controls are documented in the{" "}
              <a href="/docs/privacy/">privacy and data residency guide</a>.
            </p>
          </>
        ),
      },
      {
        title: "Optional third-party services",
        body: (
          <>
            <p>
              If you configure Beside to use a hosted model, embedding provider, plugin registry,
              update feed, MCP-compatible agent, or other third-party service, information you send
              to that service is handled by that provider under its own terms and privacy policy.
              Beside cannot control how those providers process the information you choose to send.
            </p>
            <p>
              The default local setup is intended to avoid sending your raw app data to Beside or to
              any hosted provider unless you explicitly configure that path.
            </p>
          </>
        ),
      },
      {
        title: "Support and contact",
        body: (
          <p>
            If you email us or open a GitHub issue, we receive whatever contact information and
            message content you provide. We use it to respond, troubleshoot, improve Beside, and
            maintain project records.
          </p>
        ),
      },
      {
        title: "Retention",
        body: (
          <p>
            Local app data remains on your device until you delete it or configure Beside retention
            settings to remove it. Support messages and public GitHub activity may be retained as
            long as needed for project operations, security, legal compliance, and open-source
            maintainership.
          </p>
        ),
      },
      {
        title: "Your choices",
        body: (
          <>
            <p>
              You can delete local Beside data from your machine, change capture exclusions, reduce
              retention windows, run local models, disable optional integrations, and stop using the
              app at any time.
            </p>
            <p>
              For privacy questions, contact <a href="mailto:hello@beside.so">hello@beside.so</a>.
            </p>
          </>
        ),
      },
      {
        title: "Changes",
        body: (
          <p>
            We may update this policy as Beside changes. When we do, we will update the date above
            and publish the revised policy on this page.
          </p>
        ),
      },
    ],
  },
  {
    slug: "terms",
    path: "/terms",
    title: "Terms of Service",
    description:
      "The terms for using the Beside website, downloading the app, and connecting optional services.",
    updated: "May 22, 2026",
    sections: [
      {
        title: "Acceptance",
        body: (
          <p>
            By accessing the Beside website, downloading Beside, or using related project resources,
            you agree to these terms. If you do not agree, do not use the website or software.
          </p>
        ),
      },
      {
        title: "Open-source software",
        body: (
          <>
            <p>
              Beside is open-source software distributed under the MIT License unless a specific
              file or dependency states otherwise. The license grants rights to use, copy, modify,
              merge, publish, distribute, sublicense, and sell copies of the software subject to the
              license terms.
            </p>
            <p>
              These website terms do not limit rights you receive under the open-source license.
              Third-party dependencies remain governed by their own licenses.
            </p>
          </>
        ),
      },
      {
        title: "Your responsibilities",
        body: (
          <>
            <p>
              You are responsible for how you configure and use Beside, including what you capture,
              store, export, and send to external model providers or agents. Make sure your use
              complies with laws, workplace policies, confidentiality duties, and the rights of
              others.
            </p>
            <p>
              Do not use the website, project infrastructure, or software in a way that is unlawful,
              harmful, abusive, security-invasive, or intended to disrupt the service for others.
            </p>
          </>
        ),
      },
      {
        title: "Third-party services",
        body: (
          <p>
            Beside can be configured with third-party models, plugins, package registries, update
            feeds, and MCP-compatible agents. Those services are not operated by Beside. Your use of
            them is governed by their own terms, privacy policies, limits, and fees.
          </p>
        ),
      },
      {
        title: "No professional advice",
        body: (
          <p>
            Beside may help organize, summarize, and retrieve information. It does not provide
            legal, medical, financial, security, or other professional advice. You are responsible
            for reviewing outputs and decisions before relying on them.
          </p>
        ),
      },
      {
        title: "Disclaimers",
        body: (
          <p>
            The website and software are provided "as is" and "as available" without warranties of
            any kind, express or implied, including warranties of merchantability, fitness for a
            particular purpose, title, and non-infringement. We do not promise that Beside will be
            uninterrupted, secure, error-free, or compatible with every environment.
          </p>
        ),
      },
      {
        title: "Limitation of liability",
        body: (
          <p>
            To the maximum extent permitted by law, Beside maintainers and contributors will not be
            liable for indirect, incidental, special, consequential, exemplary, or punitive damages,
            or for lost profits, data, goodwill, or business opportunities arising from your use of
            the website or software.
          </p>
        ),
      },
      {
        title: "Changes and contact",
        body: (
          <p>
            We may update these terms from time to time. The updated date above shows the latest
            revision. Questions can be sent to{" "}
            <a href="mailto:hello@beside.so">hello@beside.so</a>.
          </p>
        ),
      },
    ],
  },
];

export function findLegalPage(pathname: string): LegalPageData | null {
  const normalized = pathname === "/" ? pathname : pathname.replace(/\/+$/, "");
  return LEGAL_PAGES.find((page) => page.path === normalized) ?? null;
}
