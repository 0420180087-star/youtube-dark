

export enum ProjectStatus {
  DRAFT = 'DRAFT',
  SCRIPTING = 'SCRIPTING',
  AUDIO_GENERATED = 'AUDIO_GENERATED',
  VIDEO_GENERATED = 'VIDEO_GENERATED',
  SCHEDULED = 'SCHEDULED',
  PUBLISHED = 'PUBLISHED',
  STANDBY = 'STANDBY',
}

export type AutoPilotStep = 
  | 'idea' | 'script' | 'voice' | 'visuals' | 'studio' | 'thumbnail' | 'metadata' | 'upload';

export interface StandbyInfo {
  failedStep: AutoPilotStep;
  errorMessage: string;
  failedAt: string;
}

export type VideoDuration = 'Short (< 3 min)' | 'Standard (5-8 min)' | 'Long (10-15 min)' | 'Deep Dive (20+ min)';

export type VideoFormat = 'Landscape 16:9' | 'Portrait 9:16 (Shorts)' | 'Square 1:1';

export interface ScriptSegment {
  sectionTitle: string;
  visualDescriptions: string[];
  narratorText: string;
  soundEffects?: string[];
  estimatedDuration: number;
}

export interface ScriptData {
  title: string;
  description: string;
  brainstorming: string[];
  narrativeOutline: string[];
  coreThemes: string[];
  ambientMusicDescription?: string;
  segments: ScriptSegment[];
}

export type VisualEffect = 
  'zoom-in' | 'zoom-out' | 'pan-left' | 'pan-right' | 
  'zoom-in-fast' | 'crash-zoom' | 'ken-burns-extreme' | 
  'handheld' | 'vertigo' | 'pulse-beat' |
  'whip-pan-left' | 'whip-pan-right' | 'zoom-punch' | 'speed-ramp' |
  'hyperlapse' | 'slow-motion';

export interface VisualScene {
  segmentIndex: number;
  imageUrl: string;
  videoUrl?: string;
  videoOffset?: number;
  prompt: string;
  effect: VisualEffect;
  startTime: number;
  duration: number;
}

export interface VideoMetadata {
  youtubeTitle: string;
  youtubeDescription: string;
  tags: string[];
  categoryId?: string;
  visibility: 'public' | 'private' | 'unlisted';
  isShorts?: boolean;
}

export interface UserProfile {
  name: string;
  email: string;
  picture: string;
}

export interface YouTubeChannel {
  id: string;
  title: string;
  thumbnailUrl: string;
  subscriberCount: string;
}

export interface ProjectIdea {
  id: string;
  topic: string;
  context: string;
  specificContext?: string;
  status: 'new' | 'used' | 'dismissed';
  createdAt: string;
}

export type LibraryItemType = 'text' | 'link' | 'reference' | 'book' | 'file' | 'youtube_channel';

export interface LibraryItem {
  id: string;
  type: LibraryItemType;
  title: string;
  content: string;
  createdAt: string;
}

export interface Video {
  id: string;
  projectId: string;
  title: string;
  status: ProjectStatus;
  targetDuration: VideoDuration;
  format?: VideoFormat;
  createdAt: string;
  updatedAt: string;
  scheduledDate?: string;
  
  specificContext?: string;
  script?: ScriptData;
  audioUrl?: string;
  backgroundMusicUrl?: string;
  segmentTimestamps?: number[];
  visualScenes?: VisualScene[];
  
  thumbnailUrl?: string;
  videoMetadata?: VideoMetadata;
  youtubeUrl?: string;
  standbyInfo?: StandbyInfo;
}

export interface ScheduleSettings {
  frequencyDays: number;
  timeWindowStart: string;
  timeWindowEnd: string;
  autoGenerate?: boolean;
  nextScheduledRun?: string; // ISO date persisted for reload survival
}

export type VisualPacingStyle = 'static' | 'dynamic' | 'fast-cuts' | 'cinematic' | 'minimalist' | 'surreal' | 'vintage' | 'cyberpunk';

export interface VisualPacingSettings {
  minImagesPer5Sec: number;
  maxImagesPer5Sec: number;
  style: VisualPacingStyle;
}

export interface VisualSourceMix {
  geminiPercentage: number;
  pexelsPercentage: number;
}

export interface Project {
  id: string;
  title: string;
  description?: string;
  channelTheme: string;
  createdAt: string;
  
  defaultTone?: string;
  defaultVoice?: string;
  language?: string;
  defaultDuration?: VideoDuration;
  defaultFormat?: VideoFormat;
  visualSourceMix?: VisualSourceMix;
  visualPacing?: VisualPacingSettings;

  usedIdeas?: string[];
  ideas?: ProjectIdea[];

  library?: LibraryItem[];

  scheduleSettings?: ScheduleSettings;

  videos: Video[];
  
  isYoutubeConnected?: boolean;
  youtubeChannelData?: YouTubeChannel;
  youtubeAccessToken?: string;
}

export interface GenerateScriptParams {
  channelTheme: string;
  topic: string;
  tone: string;
  targetDuration: VideoDuration;
  language?: string; 
  additionalContext?: string;
  libraryContext?: string;
  visualPacing?: VisualPacingSettings;
  onProgress?: (text: string) => void;
}
