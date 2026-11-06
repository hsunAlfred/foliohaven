import type { APIRoute, GetStaticPaths } from 'astro';
import {
  siteManifestPaths,
  siteManifestResponse,
} from '../lib/server/site-webmanifest.js';

export const getStaticPaths = siteManifestPaths satisfies GetStaticPaths;

export const GET: APIRoute = siteManifestResponse;
