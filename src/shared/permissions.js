import { validateApiBaseUrl } from "./api-client.js";

export function hostPermissionPatternForApiUrl(apiUrl) {
  const url = validateApiBaseUrl(apiUrl);
  const hostname = url.hostname === "::1" ? "[::1]" : url.hostname;
  return `${url.protocol}//${hostname}/*`;
}

export async function ensureApiHostPermission(apiUrl, permissionsApi = globalThis.chrome?.permissions) {
  if (!permissionsApi?.contains || !permissionsApi?.request) {
    return true;
  }

  const origins = [hostPermissionPatternForApiUrl(apiUrl)];
  const alreadyGranted = await permissionsContains(permissionsApi, origins);
  if (alreadyGranted) {
    return true;
  }

  return permissionsRequest(permissionsApi, origins);
}

function permissionsContains(permissionsApi, origins) {
  return new Promise((resolve, reject) => {
    try {
      permissionsApi.contains({ origins }, resolve);
    } catch (error) {
      reject(error);
    }
  });
}

function permissionsRequest(permissionsApi, origins) {
  return new Promise((resolve, reject) => {
    try {
      permissionsApi.request({ origins }, resolve);
    } catch (error) {
      reject(error);
    }
  });
}
