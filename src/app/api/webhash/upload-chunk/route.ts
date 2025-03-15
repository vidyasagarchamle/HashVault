import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Create a temporary directory for storing chunks
const TEMP_DIR = path.join(os.tmpdir(), 'hashvault-uploads');

// Ensure temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// WARNING: On Vercel, the filesystem is ephemeral and not shared between function invocations.
// This means chunks saved in one request won't be available in another request.
// For production use with large files, implement an external storage solution (S3, etc.)
console.warn('WARNING: Using local filesystem for chunk storage. This will not work reliably on Vercel for large files.');

// New way to configure route options in Next.js App Router
export const dynamic = 'force-dynamic';
export const maxDuration = 30; // 30 seconds is enough for chunk uploads

// The correct way to set request size limits in Next.js App Router
export const fetchCache = 'force-no-store';
export const revalidate = 0;

export async function POST(request: NextRequest) {
  try {
    // Check if the request is multipart/form-data
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.includes('multipart/form-data')) {
      return NextResponse.json(
        { error: 'Request must be multipart/form-data' },
        { status: 400 }
      );
    }

    // Parse the form data
    const formData = await request.formData();
    
    // Get the file chunk
    const fileChunk = formData.get('file') as File;
    if (!fileChunk) {
      return NextResponse.json(
        { error: 'No file chunk provided' },
        { status: 400 }
      );
    }

    // Check chunk size - Vercel has a 4.5MB limit on request size
    if (fileChunk.size > 4 * 1024 * 1024) {
      return NextResponse.json(
        { error: 'Chunk size exceeds the 4MB limit' },
        { status: 413 }
      );
    }

    // Get metadata from the form
    const uploadId = formData.get('uploadId') as string;
    const chunkIndex = formData.get('chunkIndex') as string;
    const totalChunks = formData.get('totalChunks') as string;
    const fileName = formData.get('fileName') as string;

    if (!uploadId || !chunkIndex || !totalChunks || !fileName) {
      return NextResponse.json(
        { error: 'Missing required metadata' },
        { status: 400 }
      );
    }

    // Create upload directory for this upload if it doesn't exist
    const uploadDir = path.join(TEMP_DIR, uploadId);
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    // Save the chunk to disk
    const chunkPath = path.join(uploadDir, `chunk-${chunkIndex}`);
    const buffer = Buffer.from(await fileChunk.arrayBuffer());
    fs.writeFileSync(chunkPath, buffer);

    console.log(`Saved chunk ${chunkIndex} of ${totalChunks} for upload ${uploadId} (${buffer.length} bytes)`);

    // Return success response
    return NextResponse.json({
      success: true,
      message: `Chunk ${chunkIndex} of ${totalChunks} received`,
      chunkIndex,
      totalChunks,
      uploadId
    });
  } catch (error) {
    console.error('Error handling chunk upload:', error);
    return NextResponse.json(
      { error: 'Failed to process chunk upload', details: (error as Error).message },
      { status: 500 }
    );
  }
} 