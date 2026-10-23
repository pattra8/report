"use strict";

// Synthetic plates/houses/IDs only; never copy production resident records.
module.exports = [
  {
    plate: "กข1000", house: "38/90", cameraId: "8241", direction: "entry",
    nativeMapping: false,
    aliases: ["ปก100", "8ก100", "กก100"],
    reviewedIds: ["reviewed-red-1", "reviewed-red-2", "reviewed-red-3"],
  },
  {
    plate: "กค2000", house: "38/91", cameraId: "8241", direction: "entry",
    aliases: ["กจ2000"], reviewedIds: ["reviewed-white-entry"],
  },
  {
    plate: "กค2000", house: "38/91", cameraId: "8242", direction: "exit",
    aliases: ["กจ2000"], reviewedIds: ["reviewed-white-exit"],
  },
];
