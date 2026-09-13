<?php

declare(strict_types=1);

const MAX_JUNIT_BYTES = 1048576;

if ( 2 !== $argc ) {
	fwrite( STDERR, "Usage: validate-phpunit-junit.php path\n" );
	exit( 2 );
}

$path = $argv[1];
if ( ! is_file( $path ) || is_link( $path ) ) {
	fwrite( STDERR, "PHPUnit did not emit a regular JUnit result.\n" );
	exit( 2 );
}

$size = filesize( $path );
if ( false === $size || 0 === $size || $size > MAX_JUNIT_BYTES ) {
	fwrite( STDERR, "PHPUnit JUnit result must be between 1 byte and 1 MiB.\n" );
	exit( 2 );
}

$previous = libxml_use_internal_errors( true );
$document = new DOMDocument();
$loaded   = $document->load( $path, LIBXML_NONET | LIBXML_NOBLANKS );
libxml_clear_errors();
libxml_use_internal_errors( $previous );

if ( ! $loaded || ! in_array( $document->documentElement->tagName, array( 'testsuite', 'testsuites' ), true ) ) {
	fwrite( STDERR, "PHPUnit emitted an invalid JUnit result.\n" );
	exit( 2 );
}

$executed = 0;
foreach ( $document->getElementsByTagName( 'testcase' ) as $testcase ) {
	if ( 0 === $testcase->getElementsByTagName( 'skipped' )->length ) {
		++$executed;
	}
}

if ( $executed < 1 ) {
	fwrite( STDERR, "PHPUnit must execute at least one non-skipped test.\n" );
	exit( 2 );
}

fwrite( STDOUT, "PHPUnit executed {$executed} non-skipped test(s).\n" );
