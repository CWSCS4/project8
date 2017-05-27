#!/usr/bin/env python
#!/usr/bin/python

import sys
import glob

def decrementSP(): #helper function for decrementing pointer
    print "// decrement stack pointer"
    print "@SP"
    print "AM=M-1"

def accessLoc(inputC, writeTo, typeC): #inputC and writeTo are the same as in decode(). typeC is a string that is passed from the if statement blocks
    #desired output is always written to D
    if not writeTo: #in decode that signifies the assembler-friendly representation of the address
        print "// Reading " + inputC[0] + " " + inputC[1] + " into D, then A=M[SP]"
        print "@"+typeC
        print "D=M"
        print "@"+inputC[1]
        print "A=D+A"
        print "D=M"
        print "@SP"
        print "A=M"
        return "D"

    print "// Setting D to address of " + inputC[0] + " " + inputC[1] + ", then A to M[SP]"
    print "@"+typeC
    print "D=M"
    print "@"+inputC[1]
    print "D=D+A"
    print "@SP"
    print "A=M"

    return "D"

def decode(inputC,writeTo, pathInput): #gets the desired address/value from inputC case by case depending on whether writeTo is true/false. writeTo signifies either pop or push
    #desired output is always written to D
    if inputC[0]=="local": #LCL, ARG, THIS and THAT are first accessed in memory by passing in relevant arguments to accessLoc() to get the value that is being stored in the respective register
        return accessLoc(inputC, writeTo, "LCL")
    elif inputC[0]=="argument":
        return accessLoc(inputC, writeTo, "ARG")
    elif inputC[0]=="this":
        return accessLoc(inputC, writeTo, "THIS")
    elif inputC[0]=="that":
        return accessLoc(inputC, writeTo, "THAT")

    elif inputC[0]=="temp": #temp, pointer and constant are handled on their own. The first two simply add 5 or 3 (temp and pointer respectively) to the second element of inputC
        if not writeTo:
            print "@"+str(5+int(inputC[1]))
            print "D=M"
            print "@SP"
            print "A=M"
            return "D"

        return str(5+int(inputC[1]))
    elif inputC[0]=="pointer":
        if not writeTo:
            print "@"+str(3+int(inputC[1]))
            print "D=M"
            print "@SP"
            print "A=M"
            return "D"

        return str(3+int(inputC[1]))
    elif inputC[0]=="constant": #constant is handled by simply loading it into the A register and then into the D register. No support for writing to a constant is offered.
        if not writeTo:
            print "@"+inputC[1]
            print "D=A"
            return "D"

        print "why are you trying to write to a constant"

    elif inputC[0]=="static": #static variables are allocated their own space using path from command line arguments.
        tempname = pathInput.split("/")[-1].split(".")[0]
        tempname += "."
        if not writeTo:
            print "@"+tempname+inputC[1]
            print "D=M"
            return "D"
        return tempname+inputC[1]
    #All other cases can be handled by just loading the value at inputC[0]'s value (that is, an address)
    print "@" + inputC[0]
    print "D=M"
    return "D"


def pushC(inputC, pathInput): #loads SP value and increments it while writing a decoded input to the next SP address
    temp = str(decode(inputC[1:], False, pathInput))
    print "@SP"
    print "A=M"
    print "M="+temp
    print "@SP"
    print "M=M+1"

def popC(inputC, pathInput): #decrements from SP and writes previous value to specified address
    temp = str(decode(inputC[1:], True, pathInput))
    print "@R15"
    if temp == "D":
        print "M=D"
        decrementSP()
        print "D=M"
        print "@R15"
        print "A=M"
        print "M=D"
    else:
        print "@"+temp
        print "D=A"
        print "@R15"
        print "M=D"
        decrementSP()
        print "D=M"
        print "@R15"
        print "A=M"
        print "M=D"

def negC(inputC): #loads SP and negates the value at it
    print "@SP"
    print "D=M-1"
    print "A=D"
    print "M=-M"

def arithC(inputC,typeC): #general arithmatic handler, typeC is a string that holds the assembler-friendly representation of the desired address
    decrementSP()
    print "D=M"
    decrementSP()
    print "D=M"+typeC+"D"
    print "@SP"
    print "A=M"
    print "M=D"
    print "@SP"
    print "M=M+1"

def notC(inputC): #loads SP and takes the bitwise ! of its current value. I suppose I could have combined this with negC(), but since each is so short I decided to leave them be.
    print "@SP"
    print "D=M-1"
    print "A=D"
    print "M=!M"

def compC(inputC, typeC): #general comparative helper function. typeC is passed in through the main lood and represents an assembler-friendly versin of the desired comparison
    global jumpct
    decrementSP()
    print "D=M"
    decrementSP()
    print "D=M-D"
    print "@"+typeC+str(jumpct)
    print "D;"+typeC
    print "@SP"
    print "A=M"
    print "M=0"
    print "@END"+str(jumpct)
    print "0;JMP"
    print "("+typeC+str(jumpct)+")"
    print "@SP"
    print "A=M"
    print "M=-1"
    print "(END"+str(jumpct)+")"
    print "@SP"
    print "M=M+1"
    jumpct+=1

def labelC(inputC, fInput): #simple unique label handler based on arguments
    print "("+fInput+"$"+inputC[1]+")"

def gotoC(inputC, fInput): #simple unique label jump based on arguments
    print "@"+fInput+"$"+inputC[1]
    print "0;JMP"

def ifGotoC(inputC, fInput):
    decrementSP()
    print "D=M"
    print "@"+fInput+"$"+inputC[1]
    print "D;JNE"

def functionC(inputC):
    global currentF
    currentF = inputC[1]
    print "("+currentF+")"
    for i in range(int(inputC[2])):
        pushC(["","constant","0"],"notImportant")

def callC(inputC, fInput):
    global retct
    print "@return"+str(retct) #push return address
    print "D=A"
    print "@SP"
    print "A=M"
    print "M=D"
    print "@SP"
    print "M=M+1"

    pushC(["","LCL","0"], "") #push old LCL, ARG, THIS and THAT
    pushC(["","ARG","0"], "")
    pushC(["","THIS","0"], "")
    pushC(["","THAT","0"], "")

    print "@"+str(int(inputC[2])+5) #repositioning ARG to 5+n after its original value
    print "D=A"
    print "@SP"
    print "D=M-D"
    print "@ARG"
    print "M=D"

    print "@SP" #repositioning LCL to new SP
    print "D=M"
    print "@LCL"
    print "M=D"

    print "@"+inputC[1] #jump to function
    print "0;JMP"

    print "(return"+str(retct)+")" #return address label
    retct+=1

def restore(typeC, offset): #helper function to restore data after function has been completed. Takes in offset, by which it loads some value stored previously.
    #Writes stored value into register defined by typeC.
    print "@"+str(offset)
    print "D=A"
    print "@R13"
    print "A=M-D"
    print "D=M"
    print "@"+typeC
    print "M=D"

def returnC(inputC):
    print "@LCL" #storing LCL, which is used to restore LCL, ARG, THIS and THAT
    print "D=M"
    print "@R13"
    print "M=D"

    print "@5" #RET = *(FRAME-5); that is, the stored return address
    print "D=A"
    print "@R13"
    print "A=M-D"
    print "D=M"
    print "@R14"
    print "M=D"

    decrementSP() #*ARG = pop()
    print "D=M"
    print "@ARG"
    print "A=M"
    print "M=D"

    print "@ARG" #SP = ARG + 1
    print "D=M+1"
    print "@SP"
    print "M=D"

    restore("THAT",1)
    restore("THIS",2)
    restore("ARG",3)
    restore("LCL",4)

    print "@R14" #jump to return address
    print "A=M"
    print "0;JMP"

pathDir = str(sys.argv[1])
listOfFiles =  glob.glob("."+pathDir+"/*.vm")
retct = 0
jumpct = 0
currentF = "Sys.init"
print "@256"
print "D=A"
print "@SP"
print "M=D"
callC(["call","Sys.init","0"],currentF)
for path in listOfFiles:
    with open(path) as file:
        for line in file: #loops through standard input
            if line!='' and line[:2]!="//": #filters out empty lines, whitespace and comments
                try:
                    line=line[:line.index("//")]
                except:
                    pass
                current=line.split(" ")
                current = filter(lambda x:(x!=""),current)
                current = map(lambda x: x.rstrip(),current)
                typeof = current[0] #calls function based on type of command
                if typeof == "push":
                    pushC(current,path)
                elif typeof == "pop":
                    popC(current,path)
                elif typeof == "add":
                    arithC(current,"+")
                elif typeof == "sub":
                    arithC(current,"-")
                elif typeof == "neg":
                    negC(current)
                elif typeof == "eq":
                    compC(current,"JEQ")
                elif typeof == "gt":
                    compC(current,"JGT")
                elif typeof == "lt":
                    compC(current,"JLT")
                elif typeof == "and":
                    arithC(current,"&")
                elif typeof == "or":
                    arithC(current,"|")
                elif typeof == "not":
                    notC(current)
                elif typeof == "label":
                    labelC(current,currentF)
                elif typeof == "goto":
                    gotoC(current, currentF)
                elif typeof == "if-goto":
                    ifGotoC(current, currentF)
                elif typeof == "call":
                    callC(current, currentF)
                elif typeof == "function":
                    functionC(current)
                elif typeof == "return":
                    returnC(current)
