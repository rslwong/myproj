all: clean compile

clean:
	rm -f test

compile:
	rm -f test
	gcc -o test test.c
