import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import { ApiError, type ApiClient } from "../src/api.js";
import { statusFixture } from "./status.fixture.js";

function client(over: Partial<ApiClient> = {}): ApiClient {
  return {
    getStatus: vi.fn(async () => statusFixture()),
    setMode: vi.fn(async (value) => ({ ok: true as const, value, status: 200 })),
    ...over,
  };
}

describe("App (legacy-beacon.md 4)", () => {
  it("shows the polled mode, the tracker fix, and both beacons", async () => {
    render(<App api={client()} />);
    expect(await screen.findByTestId("polled-mode")).toHaveTextContent("RUN-SHOW");
    expect(screen.getByRole("button", { name: "RUN-SHOW" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("46.918520, -114.090039")).toBeInTheDocument();
    expect(screen.getByText("10.0 mph")).toBeInTheDocument();
    expect(screen.getByText("2,715 ft")).toBeInTheDocument();
    expect(screen.getByText("Battery Full at 100%")).toBeInTheDocument();
    const dev = screen.getByRole("article", { name: "dev beacon" });
    expect(within(dev).getByText("socket connected")).toBeInTheDocument();
    expect(within(dev).getByText("Spare")).toBeInTheDocument();
    expect(within(dev).getByText("no live event")).toBeInTheDocument();
    const prod = screen.getByRole("article", { name: "prod beacon" });
    expect(within(prod).getByText("Active")).toBeInTheDocument();
    expect(within(prod).getByText("live event 42")).toBeInTheDocument();
    expect(within(prod).getByText("9 delivered, sending")).toBeInTheDocument();
  });

  it("a mode button asks first and sends only on Confirm", async () => {
    const api = client();
    render(<App api={api} />);
    await screen.findByTestId("polled-mode");
    await userEvent.click(screen.getByRole("button", { name: "END-SHOW" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("END-SHOW");
    expect(api.setMode).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "PRE-SHOW" }));
    await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(api.setMode).toHaveBeenCalledWith(0));
  });

  it("a refused mode request shows the API's message", async () => {
    const api = client({
      setMode: vi.fn(async () => {
        throw new ApiError(502, "upstream_failed", "the legacy tracker refused: http 500", null);
      }),
    });
    render(<App api={api} />);
    await screen.findByTestId("polled-mode");
    await userEvent.click(screen.getByRole("button", { name: "RUN-SHOW" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("the legacy tracker refused: http 500")).toBeInTheDocument();
  });

  it("with mode control off the buttons are disabled and say so", async () => {
    const base = statusFixture();
    const api = client({ getStatus: vi.fn(async () => statusFixture({ mode: { ...base.mode, enabled: false } })) });
    render(<App api={api} />);
    expect(await screen.findByText(/Mode control is not configured/)).toBeInTheDocument();
    for (const name of ["PRE-SHOW", "RUN-SHOW", "END-SHOW"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
  });

  it("an unknown mode and a revoked beacon are flagged", async () => {
    const base = statusFixture();
    const api = client({
      getStatus: vi.fn(async () =>
        statusFixture({
          mode: { ...base.mode, polledMode: null },
          targets: [{ ...base.targets[0]!, revoked: true }],
        }),
      ),
    });
    render(<App api={api} />);
    expect(await screen.findByTestId("polled-mode")).toHaveTextContent("mode unknown");
    expect(screen.getByText(/Revoked/)).toBeInTheDocument();
  });

  it("a status poll that fails shows the service is not answering", async () => {
    const api = client({ getStatus: vi.fn(async () => Promise.reject(new Error("Failed to fetch"))) });
    render(<App api={api} />);
    expect(await screen.findByText(/The service is not answering: Failed to fetch/)).toBeInTheDocument();
  });
});
