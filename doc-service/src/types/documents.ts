import { z } from 'zod';

export const DOCUMENT_TYPES = ['invoice', 'factInvoice', 'UPD', 'TTN', 'CMR', 'AKT'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const JOB_STATUSES = ['pending', 'processing', 'done', 'failed', 'needs_review'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const OCR_ENGINES = ['pdf-text', 'tesseract', 'vision-llm', 'yandex'] as const;
export type OcrEngineName = (typeof OCR_ENGINES)[number];

// --- Schemas for `extracted` payloads, one per document type. ---

const Party = z.object({
  name: z.string(),
  inn: z.string().optional(),
  address: z.string().optional(),
});

const InvoicePosition = z.object({
  name: z.string(),
  qty: z.number().optional(),
  price: z.number().optional(),
  total: z.number().optional(),
  vat: z.number().optional(),
});

export const InvoiceExtractedSchema = z.object({
  number: z.string().optional(),
  date: z.string().optional(),
  seller: Party.partial().optional(),
  buyer: Party.partial().optional(),
  total: z.number().optional(),
  vat: z.number().optional(),
  vat_rate: z.number().optional(),
  positions: z.array(InvoicePosition).optional(),
});
export type InvoiceExtracted = z.infer<typeof InvoiceExtractedSchema>;

export const TtnExtractedSchema = z.object({
  number: z.string().optional(),
  date: z.string().optional(),
  shipper: Party.partial().optional(),
  consignee: Party.partial().optional(),
  cargo: z
    .object({
      name: z.string().optional(),
      quantity: z.number().optional(),
      weight_gross: z.number().optional(),
      weight_nett: z.number().optional(),
      places: z.number().optional(),
    })
    .optional(),
  vehicle: z
    .object({
      plate: z.string().optional(),
      driver: z.string().optional(),
    })
    .optional(),
  loading_point: z.string().optional(),
  unloading_point: z.string().optional(),
});
export type TtnExtracted = z.infer<typeof TtnExtractedSchema>;

export const CmrExtractedSchema = z.object({
  number: z.string().optional(),
  date: z.string().optional(),
  sender: Party.partial().extend({ country: z.string().optional() }).optional(),
  recipient: Party.partial().extend({ country: z.string().optional() }).optional(),
  carrier: Party.partial().optional(),
  cargo: z
    .object({
      description: z.string().optional(),
      packages: z.number().optional(),
      weight: z.number().optional(),
    })
    .optional(),
  loading_place: z.string().optional(),
  delivery_place: z.string().optional(),
});
export type CmrExtracted = z.infer<typeof CmrExtractedSchema>;

export const AktExtractedSchema = z.object({
  number: z.string().optional(),
  date: z.string().optional(),
  party_a: Party.partial().optional(),
  party_b: Party.partial().optional(),
  total: z.number().optional(),
  vat: z.number().optional(),
  services: z
    .array(
      z.object({
        name: z.string(),
        qty: z.number().optional(),
        price: z.number().optional(),
      }),
    )
    .optional(),
});
export type AktExtracted = z.infer<typeof AktExtractedSchema>;

export type Extracted =
  | InvoiceExtracted
  | TtnExtracted
  | CmrExtracted
  | AktExtracted
  | Record<string, unknown>;
