#!/bin/bash
rm $(find . -name "*.asm") 2> /dev/null
for vm_project in */*; do
	echo Compiling $vm_project
	./compile-vm-project.js $vm_project
done