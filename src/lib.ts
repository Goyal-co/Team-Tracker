export function cn(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export function personAvatarSrc(user?: { User_ID: string; Avatar_Ref?: string } | null) {
  if (!user?.Avatar_Ref) return undefined;
  return `/api/users/${user.User_ID}/avatar?v=${encodeURIComponent(user.Avatar_Ref.slice(-12))}`;
}

export function teamAvatarSrc(team?: { Team_ID: string; Avatar_Ref?: string } | null) {
  if (!team?.Avatar_Ref) return undefined;
  return `/api/teams/${team.Team_ID}/avatar?v=${encodeURIComponent(team.Avatar_Ref.slice(-12))}`;
}

const FILE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function fileMime(file: File) {
  if (file.type && file.type !== "application/octet-stream") return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return FILE_TYPES[ext] || "application/octet-stream";
}

export function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || "");
      resolve(value.slice(value.indexOf(",") + 1));
    };
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.readAsDataURL(file);
  });
}
