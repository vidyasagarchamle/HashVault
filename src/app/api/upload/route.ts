/// <reference types="node" />
import { NextRequest, NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/mongodb';
import FileModel from '@/models/File';
import { User } from '@/models/User';

// Set a timeout for the entire route
export const maxDuration = 10;

// Cache GET responses for 30 seconds
export const revalidate = 30;

// In-memory cache for file listings
const fileListCache = new Map<string, { data: any, timestamp: number }>();
const CACHE_TTL = 30 * 1000; // 30 seconds

// Database connection promise
let dbConnectionPromise: Promise<any> | null = null;

// Ensure database connection
async function ensureDbConnection() {
  if (!dbConnectionPromise) {
    console.debug('Creating new database connection promise');
    dbConnectionPromise = connectToDatabase()
      .catch(error => {
        console.error('Database connection error:', error);
        dbConnectionPromise = null;
        throw error;
      });
  }
  
  try {
    await dbConnectionPromise;
    console.debug('Database connected successfully');
    return true;
  } catch (error) {
    console.error('Database connection failed:', error);
    dbConnectionPromise = null;
    return false;
  }
}

export async function POST(request: NextRequest) {
  try {
    const data = await request.json();
    const { fileName, cid, size, mimeType, walletAddress } = data;

    console.debug('Received upload request:', { fileName, cid, size, mimeType, walletAddress });

    if (!walletAddress) {
      console.error('Upload failed: No wallet address provided');
      return NextResponse.json({ error: 'Wallet address is required' }, { status: 400 });
    }

    if (!fileName || !cid || !size || !mimeType) {
      console.error('Upload failed: Missing required fields', { fileName, cid, size, mimeType });
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    console.debug('Connecting to MongoDB...');
    const connected = await ensureDbConnection();
    if (!connected) {
      return NextResponse.json({ error: 'Failed to connect to database' }, { status: 503 });
    }

    console.debug('Creating file record:', { fileName, cid, size, mimeType, walletAddress });
    const file = await FileModel.create({
      fileName,
      cid,
      size,
      mimeType,
      walletAddress,
    });

    const sizeInBytes = parseInt(size, 10);
    if (isNaN(sizeInBytes)) {
      console.error('Invalid file size:', size);
      return NextResponse.json({ error: 'Invalid file size' }, { status: 400 });
    }

    console.debug('Updating user storage usage:', { walletAddress, sizeInBytes });
    const userUpdate = await User.findOneAndUpdate(
      { walletAddress },
      { 
        $inc: { totalStorageUsed: sizeInBytes },
        $setOnInsert: { walletAddress }
      },
      { 
        upsert: true,
        new: true
      }
    );

    if (!userUpdate) {
      console.error('Failed to update user storage usage');
      return NextResponse.json({ error: 'Failed to update user storage' }, { status: 500 });
    }

    // Invalidate cache for this user
    const cacheKey = `files:${walletAddress}`;
    fileListCache.delete(cacheKey);

    console.debug('File metadata stored successfully:', file);
    return NextResponse.json({ success: true, file });
  } catch (error) {
    console.error('Error in upload route:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    const errorDetails = error instanceof Error ? error.stack : String(error);
    
    return NextResponse.json(
      { 
        error: errorMessage,
        details: errorDetails,
        timestamp: new Date().toISOString()
      },
      { status: 500 }
    );
  }
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const walletAddress = searchParams.get('walletAddress');

    console.log("API GET request for files with params:", Object.fromEntries(searchParams.entries()));

    if (!walletAddress) {
      console.debug('No wallet address provided in request');
      return NextResponse.json(
        { error: 'Wallet address is required' },
        { status: 400 }
      );
    }

    // Check cache first
    const cacheKey = `files:${walletAddress}`;
    const cachedData = fileListCache.get(cacheKey);
    
    if (cachedData && (Date.now() - cachedData.timestamp) < CACHE_TTL) {
      console.debug(`Returning cached files (${cachedData.data.length}) for wallet:`, walletAddress);
      return NextResponse.json({ success: true, files: cachedData.data });
    }

    console.debug('Connecting to MongoDB...');
    const connected = await ensureDbConnection();
    if (!connected) {
      return NextResponse.json({ error: 'Failed to connect to database' }, { status: 503 });
    }

    console.debug('Fetching files for wallet:', walletAddress);
    const files = await FileModel.find({ walletAddress })
      .sort({ createdAt: -1 })
      .lean()
      .exec();

    // Transform the files to include _id as a string and format the size
    const transformedFiles = files.map(file => {
      // Format the file size
      let formattedSize = file.size;
      try {
        const sizeInBytes = parseInt(file.size, 10);
        if (!isNaN(sizeInBytes)) {
          if (sizeInBytes < 1024) formattedSize = `${sizeInBytes} B`;
          else if (sizeInBytes < 1024 * 1024) formattedSize = `${(sizeInBytes / 1024).toFixed(2)} KB`;
          else if (sizeInBytes < 1024 * 1024 * 1024) formattedSize = `${(sizeInBytes / (1024 * 1024)).toFixed(2)} MB`;
          else formattedSize = `${(sizeInBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
        }
      } catch (e) {
        console.error('Error formatting file size:', e);
      }

      return {
        ...file,
        _id: file._id.toString(),
        lastUpdate: file.updatedAt || file.createdAt,
        formattedSize
      };
    });

    // Cache the results
    fileListCache.set(cacheKey, {
      data: transformedFiles,
      timestamp: Date.now()
    });

    console.debug(`Found ${transformedFiles.length} files for wallet ${walletAddress}`);
    return NextResponse.json({ success: true, files: transformedFiles });
  } catch (error) {
    console.error('Error in GET files route:', error);
    return NextResponse.json(
      { 
        error: 'Failed to fetch files',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const cid = searchParams.get('cid');
    const walletAddress = searchParams.get('walletAddress');

    if (!cid || !walletAddress) {
      return NextResponse.json(
        { error: 'CID and wallet address are required' },
        { status: 400 }
      );
    }

    const connected = await ensureDbConnection();
    if (!connected) {
      return NextResponse.json({ error: 'Failed to connect to database' }, { status: 503 });
    }

    const file = await FileModel.findOne({ cid, walletAddress });
    if (!file) {
      return NextResponse.json(
        { error: 'File not found or unauthorized' },
        { status: 404 }
      );
    }

    await FileModel.deleteOne({ cid, walletAddress });

    const sizeInBytes = parseInt(file.size, 10) || 0;
    await User.findOneAndUpdate(
      { walletAddress },
      { $inc: { totalStorageUsed: -sizeInBytes } }
    );

    // Invalidate cache for this user
    const cacheKey = `files:${walletAddress}`;
    fileListCache.delete(cacheKey);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting file:', error);
    return NextResponse.json(
      { error: 'Failed to delete file' },
      { status: 500 }
    );
  }
} 