import { NextRequest, NextResponse } from 'next/server';

// Set a timeout for the entire route
export const maxDuration = 60; // 60 seconds for large file uploads

export async function POST(request: NextRequest) {
  try {
    // Get the WebHash API URL and key from environment variables
    const webhashApiUrl = process.env.NEXT_PUBLIC_WEBHASH_API_URL || 'http://52.38.175.117:5000';
    const webhashApiKey = process.env.NEXT_PUBLIC_WEBHASH_API_KEY;

    if (!webhashApiKey) {
      console.error('WebHash API key is not configured');
      return NextResponse.json(
        { error: 'WebHash API key is not configured' },
        { status: 500 }
      );
    }

    console.log('Proxying request to WebHash API:', webhashApiUrl);

    // Clone the request to forward it
    const formData = await request.formData();
    
    // Log the file being uploaded
    const file = formData.get('file') as File;
    if (file) {
      console.log('Uploading file:', {
        name: file.name,
        type: file.type,
        size: file.size
      });
    } else {
      console.error('No file found in request');
      return NextResponse.json(
        { error: 'No file found in request' },
        { status: 400 }
      );
    }

    // Forward the request to the WebHash API with timeout
    let webhashResponse;
    try {
      webhashResponse = await fetch(`${webhashApiUrl}/upload`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${webhashApiKey}`
        },
        body: formData,
        // Add a timeout to prevent hanging requests
        signal: AbortSignal.timeout(50000) // 50 second timeout
      });
    } catch (fetchError) {
      console.error('Error fetching from WebHash API:', fetchError);
      return NextResponse.json(
        { error: `WebHash API fetch error: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}` },
        { status: 500 }
      );
    }

    // If the WebHash API returns an error, return it to the client
    if (!webhashResponse.ok) {
      let errorText = '';
      try {
        errorText = await webhashResponse.text();
      } catch (e) {
        errorText = 'Could not read error response';
      }
      
      console.error('WebHash API error:', {
        status: webhashResponse.status,
        statusText: webhashResponse.statusText,
        error: errorText
      });
      
      return NextResponse.json(
        { 
          error: `WebHash API error: ${webhashResponse.status} ${webhashResponse.statusText}`,
          details: errorText
        },
        { status: webhashResponse.status }
      );
    }

    // Return the WebHash API response to the client
    let webhashData;
    try {
      webhashData = await webhashResponse.json();
      console.log('WebHash API response:', webhashData);
    } catch (jsonError) {
      console.error('Error parsing WebHash API response:', jsonError);
      return NextResponse.json(
        { error: 'Failed to parse WebHash API response' },
        { status: 500 }
      );
    }
    
    return NextResponse.json(webhashData);
  } catch (error) {
    console.error('Error in WebHash proxy:', error);
    return NextResponse.json(
      { 
        error: 'Failed to proxy request to WebHash API',
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
} 