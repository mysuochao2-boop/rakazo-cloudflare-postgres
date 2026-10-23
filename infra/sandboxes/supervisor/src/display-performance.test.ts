import { describe, expect, it } from "vitest";
import {
  computerDisplayEnv,
  containerCreateOptions,
  screenEncodingSearch,
  screenUrlFor,
} from "./computer-spec.js";
import {
  observationCaptureShell,
  observationImageOptions,
  observationRequestFields,
  parseObservation,
} from "./supervisor-logic.js";

describe("observation image encoding", () => {
  it("keeps lossless PNG unless JPEG is configured", () => {
    const png = observationImageOptions({});
    expect(png).toEqual({ format: "png", jpegQuality: 80 });
    expect(observationRequestFields(png)).toEqual({});
    expect(observationCaptureShell(png).join(";")).toContain("png:-");
  });

  it("requests bounded JPEG from control.py and the exec fallback", () => {
    const jpeg = observationImageOptions({
      RAKAZO_OBSERVE_FORMAT: "JPEG",
      RAKAZO_OBSERVE_JPEG_QUALITY: "70",
    });
    expect(jpeg).toEqual({ format: "jpeg", jpegQuality: 70 });
    expect(observationRequestFields(jpeg)).toEqual({ imageFormat: "jpeg", jpegQuality: 70 });
    const shell = observationCaptureShell(jpeg).join(";");
    expect(shell).toContain("MIME image/jpeg");
    expect(shell).toContain("-quality 70 jpeg:-");
    expect(observationImageOptions({ RAKAZO_OBSERVE_FORMAT: "jpg" }).format).toBe("jpeg");
  });

  it("rejects malformed observation settings at startup", () => {
    expect(() => observationImageOptions({ RAKAZO_OBSERVE_FORMAT: "webp" })).toThrow(/png or jpeg/);
    for (const quality of ["10", "96", "8.5", "high"]) {
      expect(() =>
        observationImageOptions({
          RAKAZO_OBSERVE_FORMAT: "jpeg",
          RAKAZO_OBSERVE_JPEG_QUALITY: quality,
        }),
      ).toThrow(/30 to 95/);
    }
  });

  it("labels the fallback frame with the captured MIME type", () => {
    expect(parseObservation("GEOM 1280 720\nMIME image/jpeg\nIMAGE AQID").mimeType).toBe(
      "image/jpeg",
    );
    expect(parseObservation("GEOM 1280 720\nIMAGE AQID").mimeType).toBe("image/png");
    expect(parseObservation("GEOM 1280 720\nIMAGE AQID")).toMatchObject({
      width: 1280,
      height: 720,
    });
  });
});

describe("computer display settings", () => {
  it("passes validated resolution and x11vnc tuning into new computers", () => {
    const displayEnv = computerDisplayEnv({
      RAKAZO_SCREEN_RESOLUTION: "1280x720",
      RAKAZO_X11VNC_ARGS: "-nowf -noxrecord -wait 10",
    });
    expect(displayEnv).toEqual([
      "RAKAZO_SCREEN_RESOLUTION=1280x720",
      "RAKAZO_X11VNC_ARGS=-nowf -noxrecord -wait 10",
    ]);
    const options = containerCreateOptions({
      name: "rakazo-bot-bot",
      image: "rakazo/computer:latest",
      botId: "bot",
      spaceId: "space",
      homePath: "/tmp/home",
      displayEnv,
    });
    expect(options.Env).toContain("RAKAZO_SCREEN_RESOLUTION=1280x720");
    expect(computerDisplayEnv({})).toEqual([]);
    expect(computerDisplayEnv({ RAKAZO_X11VNC_ARGS: "" })).toEqual(["RAKAZO_X11VNC_ARGS="]);
  });

  it("rejects resolutions and x11vnc args that could break or inject into the scripts", () => {
    for (const value of ["1280*720", "99x99", "1280x720;id", "12800x720"]) {
      expect(() => computerDisplayEnv({ RAKAZO_SCREEN_RESOLUTION: value })).toThrow(/1280x720/);
    }
    for (const value of ["-wait 10 $(id)", "-rc `id`", "-a;b", "-x\nid"]) {
      expect(() => computerDisplayEnv({ RAKAZO_X11VNC_ARGS: value })).toThrow(/flag words/);
    }
  });

  it("puts optional noVNC encoding levels on the screen URL", () => {
    expect(screenEncodingSearch({})).toBe("");
    expect(
      screenEncodingSearch({ RAKAZO_SCREEN_VNC_QUALITY: "5", RAKAZO_SCREEN_VNC_COMPRESSION: "x" }),
    ).toBe("quality=5");
    expect(
      screenUrlFor("16080", "127.0.0.1", {
        RAKAZO_SCREEN_VNC_QUALITY: "5",
        RAKAZO_SCREEN_VNC_COMPRESSION: "6",
      }),
    ).toBe("http://127.0.0.1:16080/embed.html?quality=5&compression=6");
  });
});
