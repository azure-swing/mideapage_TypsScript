import { D1Database } from '@cloudflare/workers-types';
import { R2Bucket } from '@cloudflare/workers-types';

export interface Env {
  DB_MOVIES: D1Database; // <--- 更新
  DB_MANGA: D1Database;  // <--- 更新

  MANGA_BUCKET: R2Bucket;
  MOVIES_ASSETS_BUCKET: R2Bucket;
  STATIC_FILES_BUCKET: R2Bucket;
  // STREAMS_BUCKET?: R2Bucket; // 可选

  LOGIN_CODE: string;
  SESSION_SECRET_KEY: string;
  MANGA_R2_BASE_PREFIX: string;
  MOVIE_ASSETS_R2_BASE_PREFIX: string;
  ACTOR_THUMBS_R2_SUBFOLDER: string;
  // MOVIE_STREAMS_R2_PREFIX?: string; // 可选
}

// 根据你的数据库结构定义类型
export interface Movie {
  id: number;
  root_folder: string;
  folder_path: string;
  title?: string;
  rating?: number;
  plot?: string;
  runtime?: number;
  mpaa?: string;
  uniqueid_num?: string;
  uniqueid_cid?: string;
  genres?: string; // JSON string in DB
  tags?: string; // JSON string in DB
  country?: string;
  set_name?: string;
  director?: string; // JSON string or single name
  premiered?: string;
  studio?: string;
  actors?: string; // JSON string in DB
  nfo_file_path?: string;
  strm_files?: string; // JSON string in DB, paths need to be R2 keys
  poster_file_path?: string; // R2 key
  fanart_file_path?: string; // R2 key
  last_scanned_date?: string;
  is_liked?: number | boolean; // 0 or 1 in DB
  // Fields for Emby-like response
  Id?: number;
  Name?: string;
  Type?: string;
  CommunityRating?: number;
  PremiereDate?: string;
  RunTimeTicks?: number;
  SortName?: string;
  PrimaryImageTag?: string; // URL
  BackdropImageTags?: string[]; // URLs
  People?: PersonInfo[];
  Studios?: StudioInfo[];
  Overview?: string;
  member_of_collections?: CollectionInfo[];
}

export interface Manga {
  id: number;
  title: string;
  author?: string;
  path: string; // Relative path for manga in R2 (e.g., "MangaName"), used with MANGA_IMAGES_R2_PREFIX
  cover_image?: string; // Filename of cover in R2 (e.g., "cover.jpg")
  page_count?: number;
  pages_json?: string; // JSON string of page filenames
  last_scanned?: string;
  is_appendix_to?: number;
  is_favorited?: number | boolean; // 0 or 1 in DB
  // Added for API response
  cover_image_url?: string;
  image_urls?: string[];
  appendices?: Partial<Manga>[];
  member_of_collections?: CollectionInfo[];
}

export interface ActorInfoDb {
    id: number;
    name: string;
    thumb_path?: string; // R2 key
    source_folder?: string;
    movie_count?: number;
    last_scanned?: string;
}

export interface PersonInfo {
  Name: string;
  Id: string; // Typically name for actors/directors unless you have specific IDs
  Type: 'Actor' | 'Director';
  Role?: string;
  ImageTag?: string; // URL for actor thumb
  MovieCount?: number;
}

export interface StudioInfo {
  Name: string;
  Id: string; // Typically name
  MovieCount?: number;
}

export interface CollectionInfo {
  id: number;
  name: string;
}

export interface Comment {
  id: number;
  user_name: string;
  comment_text: string;
  timestamp: string; // ISO Date string
}

export interface PrecomputedRelatedMovie {
    source_movie_id: number;
    related_movie_id: number;
    relevance_score: number;
    relation_type: string;
}
